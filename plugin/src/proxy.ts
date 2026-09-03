#!/usr/bin/env bun
import { spawn } from 'child_process'
import { appendFileSync, mkdirSync } from 'fs'
import { isAbsolute, join, resolve } from 'path'
import { createAccessReader, type Access } from './access'
import { currentActivation, deleteHeartbeat, writeHeartbeat } from './activation'
import { createDiscordClient, type DiscordClient } from './discord-api'
import { buildFooter } from './footer'
import {
  acquireInboundLock,
  createProgressTarget,
  createTypingController,
  sweepInboundLocks,
  type TargetLocation,
  type TypingController,
} from './inbound'
import { isSnowflake } from './ids'
import { botToken, ownerName } from './notify'
import { inspectOfficial, officialPluginDir } from './official'
import { createOwnerResolver } from './owner-resolver'
import { writeProgressBody, writeTarget } from './progress-target'
import { createWriter, readJsonLines, type Json, type Writer } from './relay'
import { handleEditMessage, handleReply } from './reply'
import { stateDir } from './routes'
import {
  classifyInbound,
  decideDelivery,
  decideOutbound,
  inboundFreshness,
  ownerContext,
  type OwnerContext,
} from './routing'
import { archiveStaleThreads } from './stale-threads'
import { ensureFresh } from './usage'

// cc-discord 透過プロキシ ---
// Claude Code と公式 discord channel server の間に入り stdio の JSON-RPC を中継する
// 公式 server は無改変のまま子プロセスとして起動し 差し込みたい振る舞いは MCP 境界と Discord REST で実現する
// 起動する server.ts が対応表に無ければ子を起動せず終了する (対応外のまま中継だけ続けることはしない)

// heartbeat の書き込み間隔 (watcher は 15 秒の鮮度で見る)
const HEARTBEAT_MS = 5_000
// 担当チャンネルの解決周期
const RESOLVE_MS = 60_000
// 滞留スレッドの archive 周期
const ARCHIVE_MS = 5 * 60_000
// 現行 activation のポインタを読み直すまでの待ち (hook の書き込みが MCP の初期化より遅れる場合の吸収)
const POINTER_RETRY_MS = 500
// 子プロセスの終了を待つ上限
const CHILD_EXIT_WAIT_MS = 5_000

// ログ
// 起動と破棄と失敗をすべて記録する (debug の設定では絞らない)
// 複数セッションが同じ通知を受ける構成では 破棄の記録が切り分けの手がかりになる
// 出力は 1 通知あたり 1 行で 実測でも 2 日で 100 行に満たないため 常時書いても増え方は緩やかである
export function createLogger(owner: string): (msg: string) => void {
  return (msg: string): void => {
    try {
      const dir = join(stateDir(), 'logs')
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      appendFileSync(join(dir, `proxy-${owner || 'unknown'}.log`), `[${new Date().toISOString()}] ${msg}\n`, { mode: 0o600 })
    } catch {
      // ログ失敗は本体を止めない
    }
  }
}

// initialize 応答の書き換え ---
// 子へ転送した initialize 要求の id を 1 件だけ覚え 最初に来た同じ id の応答で instructions を書き換える
// 応答の後に同じ id が別の要求へ再利用されても書き換えない
export type InitializeRewriter = {
  noteRequest(msg: Json): void
  rewrite(msg: Json): Json
}

export function createInitializeRewriter(): InitializeRewriter {
  let pendingId: unknown = undefined
  let pending = false

  return {
    noteRequest(msg: Json): void {
      if (msg.method !== 'initialize' || msg.id === undefined) return
      pendingId = msg.id
      pending = true
    },
    rewrite(msg: Json): Json {
      if (!pending || msg.id !== pendingId) return msg
      const result = msg.result
      if (typeof result !== 'object' || result === null) return msg
      const instructions = (result as Json).instructions
      if (typeof instructions !== 'string') return msg
      pending = false
      // 公式の案内する skill 名を このプラグインが同梱する名前へ差し替える
      const rewritten = instructions.replace(/\/discord:(access|configure)/g, '/cc-discord:$1')
      return { ...msg, result: { ...(result as Json), instructions: rewritten } }
    },
  }
}

// 中継のコンテキスト ---

export type ProxyContext = {
  rewriter: InitializeRewriter
  ownerCtx: OwnerContext
  api: DiscordClient
  access: () => Access
  ownerChannelId: () => string | null
  // 起動時の担当解決が終わったことを表す (成否は問わない)
  ready: Promise<void>
  typing: TypingController
  claudePid: number
  runId: string | null
  toClient: Writer
  toChild: Writer
  footer: () => string
  log: (msg: string) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// 現行 activation を解決する
// ポインタが無ければ 1 回だけ読み直す (hook と MCP の初期化の順序に依存しないため)
async function resolveActivation(ctx: ProxyContext): Promise<{ sessionId: string; activationId: string } | null> {
  if (!ctx.runId) return null
  const sleep = ctx.sleep ?? defaultSleep
  let p = currentActivation(ctx.claudePid, ctx.runId)
  if (!p) {
    await sleep(POINTER_RETRY_MS)
    p = currentActivation(ctx.claudePid, ctx.runId)
  }
  if (!p) return null
  return { sessionId: p.session_id, activationId: p.activation_id }
}

// server -> client ---
// 通知の処理は 判定段階 (失敗したら破棄) と best effort 段階 (失敗してもログを残して転送) に分ける
export async function handleServerMessage(msg: Json, raw: string, ctx: ProxyContext): Promise<void> {
  if (msg.method !== 'notifications/claude/channel') {
    ctx.toClient.write(JSON.stringify(ctx.rewriter.rewrite(msg)))
    return
  }

  const params = (msg.params ?? {}) as Json
  const meta = (params.meta ?? {}) as Json
  const decision = classifyInbound(ctx.ownerCtx, meta, (ctx.now ?? Date.now)())
  if (decision.action === 'passthrough') {
    ctx.toClient.write(raw)
    return
  }
  if (decision.action === 'drop') {
    ctx.log(`inbound dropped: ${decision.reason}`)
    return
  }

  const { owner, chatId, messageId } = decision
  const channel = await ctx.api.getChannel(chatId)
  // 起動直後は担当がまだ解決されていない
  // 未解決のまま判定すると guild の通知が NO_OWNER_CHANNEL で捨てられるため 最初の解決を待つ
  // 実体の取得と並行に進むので 実際に待つのは解決が長引いたときだけである
  await ctx.ready
  const delivery = decideDelivery({
    owner,
    ownerChannelId: ctx.ownerChannelId(),
    chatId,
    entity: channel.ok ? channel.value : null,
  })
  if (delivery.action === 'drop') {
    ctx.log(`inbound dropped: ${delivery.reason} chat=${chatId}`)
    return
  }

  // 同じ inbound を複数のセッションが処理しないよう wx で 1 プロセスに絞る
  if (!acquireInboundLock(owner, messageId)) {
    ctx.log(`inbound dropped: lock is held message=${messageId}`)
    return
  }

  // ここから先は best effort である (失敗しても通知は転送する)
  // 待ちを伴う準備 (スレッドの作成と activation の解決) だけを先に済ませ ファイルにはまだ書かない
  let location: TargetLocation | null = null
  let activation: { sessionId: string; activationId: string } | null = null
  try {
    ctx.typing.start(chatId)
    const content = typeof params.content === 'string' ? params.content : ''
    location = await createProgressTarget(ctx.api, {
      chatId,
      kind: delivery.kind,
      parentId: delivery.parentId,
      content,
      ts: new Date(),
    })
    activation = await resolveActivation(ctx)
  } catch (e) {
    ctx.log(`inbound side effects failed: ${e}`)
  }

  // 配送の直前にもう一度確かめる
  // 実体の取得から宛先の作成までは待ちの連続で その間にプロセスが長く止まることがある
  // ロックが回収された後に古い通知を配送しないための最後の関門である
  // ここで落とす場合は この通知のために始めた typing も止める
  const relayFreshness = inboundFreshness(messageId, (ctx.now ?? Date.now)())
  if (relayFreshness !== 'fresh') {
    ctx.log(`inbound dropped before relaying: ${relayFreshness} message=${messageId}`)
    ctx.typing.stop(chatId)
    return
  }

  // 宛先の公開と配送は待ちを挟まずに続けて行う
  // 途中で止まっても 配送されない通知の宛先を watcher に見せない
  if (location) {
    writeProgressBody(owner, location.id)
    if (activation) {
      writeTarget(owner, {
        ...location,
        session_id: activation.sessionId,
        run_id: ctx.runId as string,
        activation_id: activation.activationId,
        message_id: messageId,
        written_at: (ctx.now ?? Date.now)(),
      })
    } else {
      ctx.log('no current activation: the progress target was not written')
    }
  }

  ctx.toClient.write(raw)
}

// client -> server ---
// take over 対象は子へ送らず proxy が処理する
// 応答は元の id を型ごと保ち 1 回だけ返す
// take over しない送信系ツールも 宛先が担当のものかを確かめてから子へ渡す
// 公式の allowlist は bot に登録された全チャンネルを許すため それだけでは担当の分離が破れる

// 宛先を引数に持つ公式ツールと その引数名
const TARGET_ARG: Record<string, string> = {
  react: 'chat_id',
  download_attachment: 'chat_id',
  fetch_messages: 'channel',
}

// 宛先が担当のものかを確かめる (担当外なら理由を返す)
async function unownedReason(ctx: ProxyContext, chatId: unknown): Promise<string | null> {
  if (ctx.ownerCtx.kind === 'none') return null
  if (!isSnowflake(chatId)) return `invalid channel: ${String(chatId)}`
  const channel = await ctx.api.getChannel(chatId)
  const decision = decideOutbound(ctx.ownerCtx, {
    ownerChannelId: ctx.ownerChannelId(),
    chatId,
    entity: channel.ok ? channel.value : null,
  })
  return decision.ok ? null : `channel ${chatId} is not owned by this session: ${decision.reason}`
}

export async function handleClientMessage(msg: Json, raw: string, ctx: ProxyContext): Promise<void> {
  if (msg.method === 'initialize') {
    ctx.rewriter.noteRequest(msg)
    ctx.toChild.write(raw)
    return
  }
  if (msg.method !== 'tools/call') {
    ctx.toChild.write(raw)
    return
  }

  const params = (msg.params ?? {}) as Json
  const name = params.name
  const args = (params.arguments ?? {}) as Record<string, unknown>

  if (name === 'reply' || name === 'edit_message') {
    // 応答先の無い要求 (通知) には応答できないため そのまま捨てる
    if (msg.id === undefined) {
      ctx.log(`take over skipped: ${name} has no id`)
      return
    }
    const deps = {
      api: ctx.api,
      access: ctx.access,
      footer: ctx.footer,
      stopTyping: (chatId: string) => ctx.typing.stop(chatId),
      ownerCtx: ctx.ownerCtx,
      ownerChannelId: ctx.ownerChannelId,
    }
    const result = name === 'reply' ? await handleReply(args, deps) : await handleEditMessage(args, deps)
    ctx.toClient.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
    return
  }

  const targetArg = typeof name === 'string' ? TARGET_ARG[name] : undefined
  if (targetArg === undefined) {
    ctx.toChild.write(raw)
    return
  }

  const reason = await unownedReason(ctx, args[targetArg])
  if (reason === null) {
    ctx.toChild.write(raw)
    return
  }
  ctx.log(`tools/call blocked: ${name} ${reason}`)
  // 応答できない要求は捨てるだけにする (担当外の宛先を子へ渡さない)
  if (msg.id === undefined) return
  ctx.toClient.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: { content: [{ type: 'text', text: `${name} failed: ${reason}` }], isError: true },
    }),
  )
}

// 終了時の後片付け ---
// 消すのは自分の heartbeat だけである
// これを止めれば watcher は待機へ移り 30 秒で終了するので 進捗が続くことはない
//
// ポインタと宛先は残す
// MCP だけが再起動される経路 (/reload-plugins など) では SessionStart が発火せず 誰も作り直さない
// 消すと走っている turn の進捗がその場で切れ 以後の inbound も宛先を持てなくなる
// 残しても run_id の照合と heartbeat の失効で誤用は防げ 宛先は 12 時間 ポインタは 7 日の掃除で消える
export function cleanupRun(args: { claudePid: number; runId: string | null }): void {
  if (!args.runId) return
  deleteHeartbeat(args.claudePid, args.runId)
}

// 配線 ---

// 相対の DISCORD_STATE_DIR を絶対パスへ直す
// 子は --cwd で公式プラグインのディレクトリへ移るため 相対のままだと proxy と別の場所を state dir とみなす
export function absolutizeStateDir(env: NodeJS.ProcessEnv): void {
  const dir = env.DISCORD_STATE_DIR
  if (dir && !isAbsolute(dir)) env.DISCORD_STATE_DIR = resolve(dir)
}

function main(): void {
  // 子を起動する前に直す (以後の state dir の解決をすべて絶対パスで揃える)
  absolutizeStateDir(process.env)

  // 検証用の上書き: セッションの起動ディレクトリとは別の担当名で子 server を動かす
  const override = process.env.CC_DISCORD_PROJECT_DIR
  if (override) process.env.CLAUDE_PROJECT_DIR = override

  const owner = ownerName()
  const log = createLogger(owner)
  const runId = process.env.CC_DISCORD_RUN_ID ?? null
  const claudePid = process.ppid

  // 対応版判定 (通らなければ子を起動せず heartbeat も書かない)
  let installPath: string
  try {
    installPath = officialPluginDir()
  } catch (e) {
    log(`refusing to start: ${(e as Error).message}`)
    process.stderr.write(`cc-discord: ${(e as Error).message}\n`)
    process.exit(1)
  }
  const official = inspectOfficial(installPath)
  if (!official.supported) {
    const detail = `unsupported server.ts (version ${official.version}, hash ${official.execHash ?? 'unreadable'})`
    log(`refusing to start: ${detail}`)
    process.stderr.write(`cc-discord: ${detail}\n`)
    process.exit(1)
  }

  if (!runId) log('CC_DISCORD_RUN_ID is not set: progress forwarding is disabled')
  if (!botToken()) log('no bot token: REST calls will fail')

  // heartbeat は対応版判定を通った後に 1 回書いてからタイマーを始める
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  if (runId) {
    writeHeartbeat(claudePid, runId)
    heartbeatTimer = setInterval(() => void writeHeartbeat(claudePid, runId), HEARTBEAT_MS)
    heartbeatTimer.unref?.()
  }

  const api = createDiscordClient()
  const access = createAccessReader()
  const ownerCtx = ownerContext()
  const resolver = createOwnerResolver({ api, access, owner, runId, log })
  const typing = createTypingController(api, { onError: log })

  // 担当解決は子の起動を待たずに始める
  // 例外は捕まえてログに残す (担当を持たないまま fail closed で進む方が 中継ごと終了させるより安全である)
  const ready = resolver.resolve().catch((e) => log(`the initial resolution failed: ${e}`))

  log(`start pid=${process.pid} ppid=${claudePid} owner=${owner || '(none)'} official=${installPath}`)

  const child = spawn(process.execPath, ['run', '--cwd', installPath, '--shell=bun', '--silent', 'start'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  })
  child.on('error', (e) => {
    log(`child spawn failed: ${e.message}`)
    process.exit(1)
  })
  // 子が先に終了したら Claude Code に切断を検知させるため同じ終了コードで終わる
  // exit ではなく close を待つ
  // exit は stdio が閉じる前に届くことがあり そこで打ち切ると子が最後に書いた応答を捨てる
  child.on('close', (code, signal) => {
    log(`child close code=${code} signal=${signal}`)
    cleanup()
    process.exit(code ?? (signal === null ? 0 : 1))
  })
  child.stdin.on('error', () => {})

  const toChild = createWriter(child.stdin, () => {
    log('child stdin is broken')
    shutdown()
  })
  const toClient = createWriter(process.stdout, () => {
    log('client stdout is broken')
    shutdown()
  })

  const ctx: ProxyContext = {
    rewriter: createInitializeRewriter(),
    ownerCtx,
    api,
    access,
    ownerChannelId: () => resolver.channelId(),
    ready,
    typing,
    claudePid,
    runId,
    toClient,
    toChild,
    footer: () => {
      const pointer = runId ? currentActivation(claudePid, runId) : null
      ensureFresh()
      return buildFooter({
        transcriptPath: pointer?.transcript_path ?? null,
        ownerDir: ownerCtx.kind === 'none' ? null : ownerCtx.dir,
      })
    },
    log,
  }

  readJsonLines(child.stdout, {
    onMessage: (msg, raw) => handleServerMessage(msg, raw, ctx),
    onInvalid: (line) => process.stderr.write(`cc-discord: dropping a non JSON line from the child: ${line.slice(0, 200)}\n`),
    onEnd: () => shutdown(),
  })
  readJsonLines(process.stdin, {
    // take over の完了は待たず 後続メッセージの転送を止めない
    onMessage: (msg, raw) => void handleClientMessage(msg, raw, ctx),
    onInvalid: (line) => log(`dropping a non JSON line from the client: ${line.slice(0, 200)}`),
    onEnd: () => shutdown(),
  })

  // 担当解決と archive の周期
  const resolveTimer = setInterval(() => {
    void resolver.resolve().then(() => {
      ensureFresh()
      // 残置ロックの掃除は inbound の処理から外してここでまとめて行う
      // 12 時間分のロックを毎回走査すると 通知 1 件あたりの処理が重くなるためである
      if (owner) sweepInboundLocks(owner)
    })
  }, RESOLVE_MS)
  resolveTimer.unref?.()
  const archiveTimer = setInterval(() => void archive(), ARCHIVE_MS)
  archiveTimer.unref?.()

  async function archive(): Promise<void> {
    const guildId = resolver.guildId()
    const channelId = resolver.channelId()
    if (!guildId || !channelId || !owner) return
    const me = await api.getCurrentUser()
    if (!me.ok) return
    const archived = await archiveStaleThreads(api, { owner, guildId, ownerChannelId: channelId, botId: me.value.id })
    if (archived.length > 0) log(`archived ${archived.length} stale thread(s)`)
  }

  // 最初の archive は担当解決の後に 1 回だけ行う (解決の開始は上で済ませてある)
  void ready.then(archive)

  // 終了処理 ---
  let cleaned = false
  function cleanup(): void {
    if (cleaned) return
    cleaned = true
    typing.stopAll()
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    clearInterval(resolveTimer)
    clearInterval(archiveTimer)
    cleanupRun({ claudePid, runId })
  }

  let shuttingDown = false
  function shutdown(): void {
    if (shuttingDown) return
    shuttingDown = true
    log('shutting down')
    cleanup()
    try {
      child.stdin.end()
    } catch {
      // 既に閉じている場合は無視する
    }
    const timer = setTimeout(() => {
      child.kill()
      process.exit(0)
    }, CHILD_EXIT_WAIT_MS)
    timer.unref?.()
  }

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      log(`received ${sig}`)
      cleanup()
      child.kill(sig)
      shutdown()
    })
  }
  // 判定を担う proxy が不明な状態のまま中継を続けない
  process.on('uncaughtException', (e) => {
    log(`uncaught exception: ${e.stack ?? e.message}`)
    cleanup()
    child.kill()
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    log(`unhandled rejection: ${String(reason)}`)
    cleanup()
    child.kill()
    process.exit(1)
  })
}

if (import.meta.main) main()
