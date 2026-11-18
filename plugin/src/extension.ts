import { readPointer } from './activation'
import { decideChannel, findOwnClaude, selectPointer } from './binding'
import { toEntity, type ChannelLike } from './discord-entity'
import { buildFooter } from './footer'
import {
  acquireInboundLock,
  createProgressTarget,
  createTypingController,
  nodeTimers,
  sweepInboundLocks,
  type TargetLocation,
  type ThreadOps,
  type Timers,
} from './inbound'
import { createLogger } from './log'
import type { ProcessInfo } from './process-tree'
import { createProgressForwarder, type ProgressTarget, type SendResult } from './progress'
import {
  DM_CHANNEL,
  decideDelivery,
  decideOutbound,
  inboundFreshness,
  ownerContext,
  resolveOwnerChannel,
  type GuildChannels,
  type Resolution,
} from './routing'
import { archiveStaleThreads, type ThreadView } from './stale-threads'
import { defaultCloneDir, upstreamNotice } from './upstream-notice'
import { currentUsage } from './usage'

// server.ts へ公開する拡張 ---
// 担当の判定 inbound の受け入れ 進捗転送 滞留スレッドの archive footer を組み立てる
// discord.js の操作は DiscordOps として受け取る

const PLUGIN_NAME = 'cc-discord'
// ポインタを読み直す周期
const POINTER_CHECK_MS = 1_000
// transcript の増分を読む周期
const TRANSCRIPT_POLL_MS = 250
// 残置ロックの回収の周期
const LOCK_SWEEP_MS = 60_000
// 滞留スレッドの archive の周期
const ARCHIVE_MS = 5 * 60_000

export type AccessView = { allowFrom: string[]; groups: Record<string, unknown> }

export type InboundMessage = {
  id: string
  channelId: string
  content: string
  author: { id: string }
  channel: ChannelLike
}

// discord.js の操作 (失敗は null や false や { ok: false } で返す)
export type DiscordOps = ThreadOps & {
  // Gateway のキャッシュにある guild ごとのチャンネル
  guilds(): GuildChannels[]
  botId(): string | null
  channel(id: string): ChannelLike | null
  sendTyping(chatId: string): Promise<void>
  postProgress(targetId: string, text: string): Promise<SendResult>
  listActiveThreads(guildId: string): Promise<ThreadView[]>
  archive(threadId: string): Promise<boolean>
}

export type Extension = {
  // false なら公式の処理を打ち切る
  admitInbound(msg: InboundMessage): Promise<boolean>
  // 担当外のチャンネルなら例外を投げる
  owned<T extends ChannelLike>(ch: T): T
  stopTyping(chatId: string): void
  footer(): Promise<string>
  start(): void
  stop(): void
}

export function createExtension(deps: {
  ops: DiscordOps
  loadAccess: () => AccessView
  env?: NodeJS.ProcessEnv
  own?: ProcessInfo | null
  // upstream.json を含む配布物のディレクトリ
  pluginDir?: string
  now?: () => number
  log?: (msg: string) => void
  timers?: Timers
}): Extension {
  const { ops, loadAccess, pluginDir } = deps
  const env = deps.env ?? process.env
  const now = deps.now ?? Date.now
  const timers = deps.timers ?? nodeTimers
  const ownerCtx = ownerContext(env)
  const owner = ownerCtx.kind === 'named' ? ownerCtx.owner : null
  const log = deps.log ?? createLogger(owner ?? '')
  const root = env.CLAUDE_PLUGIN_ROOT ?? pluginDir
  const own = deps.own !== undefined ? deps.own : root ? findOwnClaude(process.ppid, root) : null
  const channel = decideChannel(own, PLUGIN_NAME, env)

  // async で包み 同期の例外も reject として typing 側で記録させる
  const typing = createTypingController(async (chatId) => ops.sendTyping(chatId), { timers, onError: log })
  const activation = () => selectPointer(own, readPointer)

  const resolveOwned = (): Resolution =>
    owner ? resolveOwnerChannel(ops.guilds(), loadAccess().groups, owner) : { kind: 'unresolved' }

  // DM の判定は担当チャンネルに依存しないため guild の一覧を引かない
  const ownerChannelId = (ch: ChannelLike): string | null => {
    if (ch.type === DM_CHANNEL) return null
    const r = resolveOwned()
    return r.kind === 'resolved' ? r.channelId : null
  }

  // 進捗の投稿の直前に宛先が今も担当のものかを確かめる (例外は送らない扱いにする)
  const canSend = (t: ProgressTarget): boolean => {
    if (!owner) return false
    try {
      const ch = ops.channel(t.id)
      if (!ch) return false
      const decision = decideDelivery({ owner, ownerChannelId: ownerChannelId(ch), chatId: t.id, entity: toEntity(ch) })
      if (decision.action === 'drop') return false
      if (decision.kind === 'guild') return true
      const recipient = ch.recipientId ?? t.recipientId
      return !!recipient && loadAccess().allowFrom.includes(recipient)
    } catch (e) {
      log(`[progress] checking the target failed: ${e}`)
      return false
    }
  }

  const forwarder = createProgressForwarder({
    activation,
    canSend,
    send: (targetId, text) => ops.postProgress(targetId, text),
    now,
    log,
  })

  // inbound を受け入れるかを決め 受け入れるなら進捗の宛先を設定する
  // 受領リアクションと添付の一覧は公式の処理に残す
  const admit = async (msg: InboundMessage): Promise<boolean> => {
    const chatId = msg.channelId
    const drop = (reason: string): false => {
      log(`[inbound] dropped: ${reason} chat=${chatId} message=${msg.id}`)
      return false
    }
    if (!channel.enabled) return drop('CHANNEL_DISABLED')
    // 担当名を持たないセッションは判定もロックもせずに通す (単独運用)
    if (ownerCtx.kind === 'none') {
      typing.start(chatId)
      return true
    }
    if (!owner) return drop('ROUTING_BROKEN')

    const delivery = decideDelivery({
      owner,
      ownerChannelId: ownerChannelId(msg.channel),
      chatId,
      entity: toEntity(msg.channel),
    })
    if (delivery.action === 'drop') return drop(delivery.reason)
    const freshness = inboundFreshness(msg.id, now())
    if (freshness !== 'fresh') return drop(freshness)
    if (!acquireInboundLock(owner, msg.id)) return drop('LOCK_HELD')
    typing.start(chatId)

    const pointer = activation()
    let location: TargetLocation | null = null
    if (pointer) {
      try {
        location = await createProgressTarget(ops, {
          chatId,
          kind: delivery.kind,
          parentId: delivery.parentId,
          content: msg.content,
          ts: new Date(now()),
        })
      } catch (e) {
        log(`[inbound] creating the progress thread failed: ${e}`)
      }
    } else {
      log('[inbound] no current activation: the progress thread was not created')
    }

    // スレッドの作成を待つ間に鮮度が切れることがある
    const recheck = inboundFreshness(msg.id, now())
    if (recheck !== 'fresh') {
      typing.stop(chatId)
      return drop(`${recheck} after preparing`)
    }
    if (pointer && location) {
      forwarder.setTarget({
        id: location.id,
        parentId: location.parent,
        kind: location.kind,
        activationId: pointer.activation_id,
        setAt: now(),
        ...(location.kind === 'dm' ? { recipientId: msg.author.id } : {}),
      })
    }
    return true
  }

  const archive = async (): Promise<void> => {
    const r = resolveOwned()
    if (r.kind !== 'resolved') return
    const botId = ops.botId()
    if (!botId) return
    const { guildId, channelId } = r
    const archived = await archiveStaleThreads(
      { listActiveThreads: () => ops.listActiveThreads(guildId), archive: (id) => ops.archive(id) },
      { parentId: channelId, botId, currentTargetId: forwarder.currentTargetId(), now: now() },
    )
    if (archived.length > 0) log(`[archive] archived ${archived.length} stale thread(s)`)
  }

  // 同期の例外も reject もログに残して次の周期へ進む
  const guarded =
    (name: string, job: () => unknown) =>
    async (): Promise<void> => {
      try {
        await job()
      } catch (e) {
        log(`[${name}] failed: ${e}`)
      }
    }

  // ロックの取得と宛先の設定の順序を保つため inbound を直列に処理する
  let chain: Promise<unknown> = Promise.resolve()
  const handles: unknown[] = []

  return {
    admitInbound(msg: InboundMessage): Promise<boolean> {
      const result = chain
        .then(() => admit(msg))
        .catch((e: unknown) => {
          log(`[inbound] handling failed: ${e}`)
          return false
        })
      chain = result
      return result
    },

    owned<T extends ChannelLike>(ch: T): T {
      const decision = decideOutbound(ownerCtx, {
        ownerChannelId: ownerChannelId(ch),
        chatId: ch.id,
        entity: toEntity(ch),
      })
      if (decision.ok) return ch
      log(`[outbound] blocked: ${decision.reason} chat=${ch.id}`)
      throw new Error(`channel ${ch.id} is not owned by this session: ${decision.reason}`)
    },

    stopTyping(chatId: string): void {
      typing.stop(chatId)
    },

    // 失敗はログに残して空文字を返し reply の本文の送信を止めない
    async footer(): Promise<string> {
      try {
        return buildFooter({
          transcriptPath: activation()?.transcript_path ?? null,
          ownerDir: ownerCtx.kind === 'none' ? null : ownerCtx.dir,
          usage: await currentUsage(),
          notice: pluginDir ? upstreamNotice({ env, pluginDir, cloneDir: defaultCloneDir(env) }) : null,
          env,
        })
      } catch (e) {
        log(`[footer] building the footer failed: ${e}`)
        return ''
      }
    },

    start(): void {
      log(`[channel] ${channel.enabled ? 'enabled' : 'disabled'}: ${channel.reason}`)
      handles.push(
        timers.setInterval(guarded('progress', () => forwarder.tick()), POINTER_CHECK_MS),
        timers.setInterval(guarded('progress', () => forwarder.poll()), TRANSCRIPT_POLL_MS),
        timers.setInterval(
          guarded('lock', () => {
            if (owner) sweepInboundLocks(owner, now())
          }),
          LOCK_SWEEP_MS,
        ),
        timers.setInterval(guarded('archive', archive), ARCHIVE_MS),
      )
      void guarded('archive', archive)()
    },

    stop(): void {
      for (const h of handles.splice(0)) timers.clearInterval(h)
      typing.stopAll()
    },
  }
}
