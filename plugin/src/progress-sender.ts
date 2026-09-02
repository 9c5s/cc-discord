import type { Access } from './access'
import { HEARTBEAT_TTL_MS, isFresh, readHeartbeat, readPointer } from './activation'
import type { DiscordClient } from './discord-api'
import { isActiveFor, readTarget } from './progress-target'
import { DM_CHANNEL, decideDelivery, resolveOwnerChannel, type ChannelEntity } from './routing'

// 進捗の送信 ---
// 送信のたびに activation の確認と outbound gate を通す
// 判定は state dir のファイルではなく API から取得した実体で行い ファイル操作の成否に依存させない
// 実行順は 事前確認 -> gate (REST を伴う判定) -> 最終再確認 -> await を挟まず POST とし
// gate の待ちの間に activation が切り替わった項目は最終再確認で破棄する

// 通知を出さない投稿 (SUPPRESS_NOTIFICATIONS)
const SUPPRESS_NOTIFICATIONS = 1 << 12
// Discord の上限に対する最終安全弁 (コードポイント単位で数える)
const MAX_CONTENT_POINTS = 1900
// 429 の待ちに付き合う上限
// これを超える待ちは諦める (途中経過は遅れて届いても価値が薄く 待つ間に activation も変わりやすい)
const MAX_RETRY_WAIT_MS = 10_000

export type SendOutcome = 'sent' | 'dropped' | 'terminated'

export type SenderDeps = {
  api: DiscordClient
  access: () => Access
  owner: string
  claudePid: number
  runId: string
  activationId: string
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  log?: (msg: string) => void
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function createProgressSender(deps: SenderDeps): { send(text: string): Promise<SendOutcome> } {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? defaultSleep
  const log = deps.log ?? ((): void => {})

  // activation の確認
  // heartbeat が自分の run のもので鮮度内 かつ ポインタの activation が一致することを要求する
  const activationHolds = (): boolean => {
    const beat = readHeartbeat(deps.claudePid, deps.runId)
    if (!beat || !isFresh(beat.written_at, HEARTBEAT_TTL_MS, now())) return false
    return readPointer(deps.claudePid)?.activation_id === deps.activationId
  }

  // 宛先の実体を取得して要求した id と一致することを確かめる
  const fetchEntity = async (id: string): Promise<ChannelEntity | null> => {
    const res = await deps.api.getChannel(id)
    if (!res.ok || res.value.id !== id) return null
    return res.value
  }

  // 担当チャンネルを決定関数で解決する (proxy の担当解決と同じ関数)
  const resolveOwned = async (access: Access): Promise<string | null> => {
    const guilds = await deps.api.getGuilds()
    if (!guilds.ok) return null
    const entries = []
    for (const g of guilds.value) {
      const channels = await deps.api.getGuildChannels(g.id)
      if (!channels.ok) return null
      entries.push({ guildId: g.id, channels: channels.value })
    }
    const resolution = resolveOwnerChannel(entries, access.groups, deps.owner)
    return resolution.kind === 'resolved' ? resolution.channelId : null
  }

  // outbound gate
  // 宛先の実体を取り inbound と同じ決定関数で担当のものかを確かめる
  // DM は担当名 (cc-discord) で決まり さらに実際の相手が allowFrom にあることを要求する
  // guild は親 (スレッドなら parent_id) が現在の担当と一致することを要求する
  const passesGate = async (targetId: string): Promise<boolean> => {
    const access = deps.access()
    const entity = await fetchEntity(targetId)
    if (!entity) return false

    // 担当チャンネルの解決は guild の宛先にだけ要る (DM は担当解決に依存しない)
    const ownerChannelId = entity.type === DM_CHANNEL ? null : await resolveOwned(access)
    const decision = decideDelivery({ owner: deps.owner, ownerChannelId, chatId: targetId, entity })
    if (decision.action === 'drop') return false
    if (decision.kind === 'dm') {
      const recipient = entity.recipients?.[0]?.id
      return typeof recipient === 'string' && access.allowFrom.includes(recipient)
    }
    return true
  }

  const send = async (text: string): Promise<SendOutcome> => {
    if (!text.trim()) return 'dropped'
    const points = [...text]
    const content = points.length > MAX_CONTENT_POINTS ? points.slice(0, MAX_CONTENT_POINTS).join('') : text

    // 429 の待機後は新しい送信試行として最初からやり直す
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!activationHolds()) return 'terminated'

      const target = readTarget(deps.owner, deps.activationId)
      if (!target || !isActiveFor(target, deps.activationId, now())) {
        log('progress skip: no active target')
        return 'dropped'
      }

      if (!(await passesGate(target.id))) {
        log(`progress skip: outbound gate rejected ${target.id}`)
        return 'dropped'
      }

      // 最終再確認の後は await を挟まずに POST を始める
      if (!activationHolds()) return 'terminated'
      const res = await deps.api.createMessage(
        target.id,
        { content, flags: SUPPRESS_NOTIFICATIONS, allowed_mentions: { parse: [] } },
        undefined,
        { autoRetry: false },
      )
      if (res.ok) return 'sent'
      if (res.retryAfterMs === undefined) {
        log(`progress send failed: ${res.error}`)
        return 'dropped'
      }
      if (res.retryAfterMs > MAX_RETRY_WAIT_MS) {
        log(`progress skip: rate limited for ${res.retryAfterMs}ms`)
        return 'dropped'
      }
      await sleep(res.retryAfterMs)
    }
    return 'dropped'
  }

  return { send }
}
