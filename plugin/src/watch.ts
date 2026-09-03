import { thinkingGist, toolSummary, truncate } from './summarize'
import { ownerName, debugLog } from './notify'
import { createAccessReader } from './access'
import { HEARTBEAT_TTL_MS, isFresh, readHeartbeat, readPointer } from './activation'
import { createDiscordClient } from './discord-api'
import { isHex32, isPid, isSessionId } from './ids'
import { createProgressSender, type SendOutcome } from './progress-sender'
import { statSync, openSync, readSync, closeSync, existsSync } from 'fs'
import { StringDecoder } from 'string_decoder'

// JSONL の1行から転送すべきメッセージ配列を返す純粋関数
// 空行/parse 失敗/非 assistant 行/content が配列でない場合は空配列を返す
export function extractMessages(line: string): string[] {
  if (!line.trim()) return []
  let rec: unknown
  try { rec = JSON.parse(line) } catch { return [] }
  if (typeof rec !== 'object' || rec === null) return []
  const r = rec as Record<string, unknown>
  if (r.type !== 'assistant') return []
  const msg = r.message
  if (typeof msg !== 'object' || msg === null) return []
  const content = (msg as Record<string, unknown>).content
  if (!Array.isArray(content)) return []

  const results: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as Record<string, unknown>
    if (b.type === 'thinking' && typeof b.thinking === 'string') {
      // 注: 現環境では thinking が署名付きで transcript に本文が記録されず
      // thinking が空文字になるため ここは実質 no-op となる (2026-05-27 検証で判明)
      // 将来 Claude Code が thinking 本文を記録する版に備えてコードは残す
      // thinkingGist が空文字 (空入力) を返す場合は追加しない
      const gist = thinkingGist(b.thinking)
      if (gist) results.push(gist)
    } else if (b.type === 'text' && typeof b.text === 'string') {
      const t = b.text.trim()
      if (!t) continue
      // resume 時に Claude が出す定型応答は Discord に流さない
      if (t === 'No response requested.') continue
      // truncate でコードポイント単位に 1800 字で切り詰める
      results.push('💬 ' + truncate(t, 1800))
    } else if (b.type === 'tool_use' && typeof b.name === 'string') {
      // tool_use も transcript から拾って同一経路で送る
      // PreToolUse hook 経由の即時送信は
      // assistant message の transcript 書き込みより早く発火するため text と並びが逆転する
      // watch 一本化することで JSONL の content 順を Discord 表示順に保つ
      const input = (typeof b.input === 'object' && b.input !== null) ? b.input as Record<string, unknown> : {}
      results.push(toolSummary(b.name, input))
    }
    // その他のブロックはスキップする
  }
  return results
}

// メッセージ配列を改行結合で maxLen 以下のチャンク列に詰める
// 送信側は 1900 字で切り捨てるため まとめ送信が長くなるとコードブロックの終端ごと
// 失われて表示が壊れる
// これを防ぐためメッセージ境界で送信単位を分割する
// 単一メッセージが maxLen を超える場合はそのまま 1 チャンクにする (送信側の切り捨てが最終安全弁)
export function packMessages(messages: string[], maxLen = 1900): string[] {
  const chunks: string[] = []
  let cur = ''
  for (const m of messages) {
    if (!cur) cur = m
    else if (cur.length + 1 + m.length <= maxLen) cur += '\n' + m
    else {
      chunks.push(cur)
      cur = m
    }
  }
  if (cur) chunks.push(cur)
  return chunks
}

// 行分割ロジックを純粋関数に抽出する
// carry と読み取りチャンクを結合し改行で分割する
// 未完の最終行を次回へ持ち越す
export function splitLines(carry: string, chunk: string): { lines: string[]; carry: string } {
  const combined = carry + chunk
  const parts = combined.split('\n')
  const newCarry = parts.pop() ?? ''
  return { lines: parts, carry: newCarry }
}

// 起動引数 ---
// watcher は activation 単位で起動されるため 5 つの識別子をすべて必須にする
// 旧 global hook の watch.ts <transcript_path> だけの起動はここで無効化される

export type WatchArgs = {
  transcriptPath: string
  sessionId: string
  claudePid: number
  runId: string
  activationId: string
}

export function parseWatchArgs(argv: string[]): WatchArgs | null {
  const [transcriptPath, sessionId, claudePid, runId, activationId] = argv
  if (!transcriptPath) return null
  if (!isSessionId(sessionId)) return null
  if (!isPid(claudePid)) return null
  if (!isHex32(runId) || !isHex32(activationId)) return null
  return { transcriptPath, sessionId, claudePid: Number(claudePid), runId, activationId }
}

// watcher 本体 ---
// 状態は WAIT_HEARTBEAT -> ACTIVE -> TERMINATED の 3 つである
// 起動時に読み取り位置を EOF で確定し 待機中は transcript を読まず送信もしない
// ACTIVE では毎秒 heartbeat とポインタを確認し 満たされなくなったら終了する

// 最初の有効な heartbeat を待つ上限 (hook と proxy の初期化の順序に依存しないため)
const WAIT_HEARTBEAT_MAX_MS = 30_000
// transcript のポーリング間隔
const POLL_MS = 250
// activation の確認間隔
const TICK_MS = 1_000

export type WatcherState = 'WAIT_HEARTBEAT' | 'ACTIVE' | 'TERMINATED'

export type Watcher = {
  state(): WatcherState
  tick(): void
  poll(): Promise<void>
}

export function createWatcher(deps: {
  transcriptPath: string
  claudePid: number
  runId: string
  activationId: string
  send: (text: string) => Promise<SendOutcome>
  now?: () => number
  log?: (msg: string) => void
}): Watcher {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((): void => {})
  let waitStart = now()

  let state: WatcherState = 'WAIT_HEARTBEAT'
  // 起動時点の EOF を読み取り位置にする (待機中の追記は ACTIVE 移行後に順番に処理される)
  let offset = existsSync(deps.transcriptPath) ? statSync(deps.transcriptPath).size : 0
  let carry = ''
  let decoder = new StringDecoder('utf8')
  let polling = false

  const heartbeatHolds = (): boolean => {
    const beat = readHeartbeat(deps.claudePid, deps.runId)
    return beat !== null && isFresh(beat.written_at, HEARTBEAT_TTL_MS, now())
  }

  const pointerHolds = (): boolean =>
    readPointer(deps.claudePid)?.activation_id === deps.activationId

  const activationHolds = (): boolean => heartbeatHolds() && pointerHolds()

  const terminate = (reason: string): void => {
    state = 'TERMINATED'
    log(`[watch] terminated: ${reason}`)
  }

  // transcript の増分を読む
  // ローテーションや truncate を検出したら読み取り状態と decoder の部分バイトを破棄する
  const readNewLines = (): string[] => {
    if (!existsSync(deps.transcriptPath)) return []
    const size = statSync(deps.transcriptPath).size
    if (size < offset) {
      offset = 0
      carry = ''
      decoder = new StringDecoder('utf8')
    }
    if (size === offset) return []
    const fd = openSync(deps.transcriptPath, 'r')
    let chunk = ''
    try {
      // readSync は要求より少なく読むことがある (同時更新中の transcript との競合)
      const buf = Buffer.alloc(size - offset)
      const bytesRead = readSync(fd, buf, 0, buf.length, offset)
      offset += bytesRead
      chunk = decoder.write(buf.subarray(0, bytesRead))
    } finally {
      closeSync(fd)
    }
    const result = splitLines(carry, chunk)
    carry = result.carry
    return result.lines
  }

  return {
    state: () => state,

    tick(): void {
      if (state === 'TERMINATED') return
      if (state === 'WAIT_HEARTBEAT') {
        if (heartbeatHolds()) {
          state = 'ACTIVE'
          return
        }
        if (now() - waitStart > WAIT_HEARTBEAT_MAX_MS) terminate('heartbeat not observed')
        return
      }
      if (activationHolds()) return
      // heartbeat が失効しただけなら待機へ戻す
      // サスペンドからの復帰直後と MCP だけの再起動では proxy がまだ書き直していない
      // どちらも tick より書き直しが遅れるだけなので ここで終了させると同じ activation では二度と再開しない
      // ポインタが別の activation を指していたら 待たずに終了する
      if (pointerHolds()) {
        state = 'WAIT_HEARTBEAT'
        waitStart = now()
        return
      }
      terminate('activation is no longer current')
    },

    async poll(): Promise<void> {
      if (state !== 'ACTIVE' || polling) return
      // heartbeat が失効している間は transcript を読まない
      // 読み取り位置だけ進めても 送信側が同じ理由で諦めるため その分の進捗を取り戻せない
      // 読まずに待てば proxy が書き直した後の周期でまとめて送れる
      if (!heartbeatHolds()) return
      polling = true
      try {
        const messages: string[] = []
        for (const line of readNewLines()) {
          for (const msg of extractMessages(line)) messages.push(msg)
        }
        if (messages.length === 0) return
        debugLog(`poll: ${messages.length} msgs`)
        for (const c of packMessages(messages)) {
          const outcome = await deps.send(c)
          if (outcome === 'terminated') {
            terminate('sender observed a different activation')
            return
          }
        }
      } catch (e) {
        // 読み取りの失敗ではセッションを止めない
        log(`[watch] ${e}`)
      } finally {
        polling = false
      }
    },
  }
}

// このファイルが直接実行された場合のみ常駐ループを起動する
// テストからインポートされた場合は実行しない
if (import.meta.main) {
  const args = parseWatchArgs(process.argv.slice(2))
  const owner = ownerName()
  // 引数の形式が不正 または担当なしなら何もせず終了する
  if (!args || !owner) process.exit(0)

  const sender = createProgressSender({
    api: createDiscordClient(),
    access: createAccessReader(),
    owner,
    claudePid: args.claudePid,
    runId: args.runId,
    activationId: args.activationId,
    log: debugLog,
  })
  const watcher = createWatcher({ ...args, send: sender.send, log: debugLog })

  const timers: Array<ReturnType<typeof setInterval>> = []
  const stopIfTerminated = (): void => {
    if (watcher.state() !== 'TERMINATED') return
    for (const t of timers) clearInterval(t)
    process.exit(0)
  }
  timers.push(setInterval(() => {
    watcher.tick()
    stopIfTerminated()
  }, TICK_MS))
  timers.push(setInterval(() => {
    void watcher.poll().then(stopIfTerminated)
  }, POLL_MS))
}
