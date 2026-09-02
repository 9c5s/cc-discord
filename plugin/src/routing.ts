import { normalizeName, ownerFromDir } from './normalize'
import { isSnowflake } from './ids'

// 担当名の解決 ---
// 担当ディレクトリは CC_DISCORD_PROJECT_DIR (検証用の上書き) を CLAUDE_PROJECT_DIR より優先する
// proxy / hook / watcher がすべてこの関数を使うため 同じセッションの全構成要素が同じ担当名になる

export type OwnerContext =
  | { kind: 'none' }
  | { kind: 'broken'; dir: string }
  | { kind: 'named'; owner: string; dir: string }

// 担当ディレクトリと担当名を決める
// ディレクトリ未設定は担当なし (単独運用の後方互換で全通知を素通しする)
// ディレクトリがあるのに正規化名が空なら broken とし fail closed の対象にする
export function ownerContext(env: NodeJS.ProcessEnv = process.env): OwnerContext {
  const dir = env.CC_DISCORD_PROJECT_DIR || env.CLAUDE_PROJECT_DIR || ''
  if (!dir) return { kind: 'none' }
  const owner = ownerFromDir(dir)
  if (!owner) return { kind: 'broken', dir }
  return { kind: 'named', owner, dir }
}

// 担当チャンネルの決定関数 ---
// proxy の担当解決と watcher の outbound gate が同じ関数を使い 同じ入力から同じ結果を得る
// 候補が複数のときに先頭を選ぶ規則は設けず 曖昧として fail closed にする

// GuildText のチャンネル種別
const GUILD_TEXT = 0

export type Channel = { id?: unknown; name?: unknown; type?: unknown }
export type GuildChannels = { guildId: string; channels: Channel[] }

export type Resolution =
  | { kind: 'resolved'; channelId: string; guildId: string }
  | { kind: 'unresolved' }
  | { kind: 'ambiguous'; channelIds: string[] }

// 全 guild のチャンネル一覧と access.groups と担当名から担当チャンネルを決める
// 候補は GuildText かつ正規化名が担当名と一致し かつ access.groups に含まれるものである
// 0 件は未解決 2 件以上は曖昧 1 件だけが担当になる
export function resolveOwnerChannel(
  guilds: GuildChannels[],
  groups: Record<string, unknown>,
  owner: string,
): Resolution {
  // 担当名が空のときに正規化名の空一致で拾わないよう先に打ち切る
  if (!owner) return { kind: 'unresolved' }

  const found: Array<{ channelId: string; guildId: string }> = []
  for (const g of guilds) {
    for (const c of g.channels) {
      if (c.type !== GUILD_TEXT) continue
      if (!isSnowflake(c.id)) continue
      if (typeof c.name !== 'string') continue
      if (normalizeName(c.name) !== owner) continue
      if (!Object.prototype.hasOwnProperty.call(groups, c.id)) continue
      found.push({ channelId: c.id, guildId: g.guildId })
    }
  }

  if (found.length === 0) return { kind: 'unresolved' }
  if (found.length > 1) return { kind: 'ambiguous', channelIds: found.map((f) => f.channelId) }
  return { kind: 'resolved', channelId: found[0].channelId, guildId: found[0].guildId }
}

// inbound 通知のルーティング判定 ---
// 実体取得の前後で 2 段階に分ける
// 前段 (classifyInbound) は担当名と識別子だけで判定し 実体取得が要る場合だけ inspect を返す
// 後段 (decideDelivery) は取得したチャンネル実体で担当を判定する
// 判定に失敗する経路はすべて破棄 (fail closed) にする

// DM を担当するのはこの名前のセッションだけである (guild の担当解決には依存しない)
const DM_OWNER = 'cc-discord'
// DM のチャンネル種別
const DM = 1
// スレッドのチャンネル種別 (announcement / public / private)
const THREAD_TYPES = new Set([10, 11, 12])

// 実体がスレッドかどうかを判定する
// GuildText の parent_id は所属カテゴリを指すため 親を辿るのはスレッドのときだけである
export function isThread(entity: ChannelEntity): boolean {
  return THREAD_TYPES.has(entity.type as number)
}

export type InboundMeta = { chat_id?: unknown; message_id?: unknown }

export type InboundClass =
  | { action: 'passthrough' }
  | { action: 'drop'; reason: string }
  | { action: 'inspect'; owner: string; chatId: string; messageId: string }

// 担当名と通知 meta から 実体取得の要否を決める
export function classifyInbound(ctx: OwnerContext, meta: InboundMeta): InboundClass {
  if (ctx.kind === 'none') return { action: 'passthrough' }
  if (ctx.kind === 'broken') return { action: 'drop', reason: 'ROUTING_BROKEN' }
  if (!isSnowflake(meta.chat_id) || !isSnowflake(meta.message_id)) return { action: 'drop', reason: 'INVALID_ID' }
  return { action: 'inspect', owner: ctx.owner, chatId: meta.chat_id, messageId: meta.message_id }
}

// GET /channels/{id} の応答のうち判定に使う部分
export type ChannelEntity = {
  id?: unknown
  type?: unknown
  parent_id?: unknown
  guild_id?: unknown
  recipients?: Array<{ id?: unknown }>
}

export type DeliveryDecision =
  | { action: 'handle'; kind: 'guild' | 'dm'; parentId: string }
  | { action: 'drop'; reason: string }

// チャンネル実体から配送の可否を決める
// entity が null (取得失敗) と id 不一致は破棄する
// guild は親 (スレッドなら parent_id) が担当チャンネルであることを要求する
// DM は担当名だけで決まり メモリ上の担当チャンネルには依存しない
export function decideDelivery(input: {
  owner: string
  ownerChannelId: string | null
  chatId: string
  entity: ChannelEntity | null
}): DeliveryDecision {
  const { owner, ownerChannelId, chatId, entity } = input
  if (!entity) return { action: 'drop', reason: 'CHANNEL_FETCH_FAILED' }
  if (entity.id !== chatId) return { action: 'drop', reason: 'CHANNEL_ID_MISMATCH' }

  if (entity.type === DM) {
    if (owner !== DM_OWNER) return { action: 'drop', reason: 'NOT_DM_OWNER' }
    return { action: 'handle', kind: 'dm', parentId: chatId }
  }

  if (!ownerChannelId) return { action: 'drop', reason: 'NO_OWNER_CHANNEL' }
  const parentId = isThread(entity)
    ? (isSnowflake(entity.parent_id) ? entity.parent_id : null)
    : chatId
  if (parentId !== ownerChannelId) return { action: 'drop', reason: 'NOT_OWNED' }
  return { action: 'handle', kind: 'guild', parentId }
}

// 送信先の担当判定 (outbound gate) ---
// 送信系ツールの宛先を inbound と同じ決定関数で絞り 担当外のチャンネルに触れさせない
// 担当ディレクトリが未設定のセッションでは判定を行わない (単独運用の後方互換)

export type OutboundDecision = { ok: true } | { ok: false; reason: string }

export function decideOutbound(
  ctx: OwnerContext,
  input: { ownerChannelId: string | null; chatId: string; entity: ChannelEntity | null },
): OutboundDecision {
  if (ctx.kind === 'none') return { ok: true }
  if (ctx.kind === 'broken') return { ok: false, reason: 'ROUTING_BROKEN' }
  const decision = decideDelivery({
    owner: ctx.owner,
    ownerChannelId: input.ownerChannelId,
    chatId: input.chatId,
    entity: input.entity,
  })
  return decision.action === 'handle' ? { ok: true } : { ok: false, reason: decision.reason }
}
