import { readFileSync } from 'fs'
import { join } from 'path'
import { stateDir } from './routes'
import { isThread, type ChannelEntity } from './routing'

// access.json の読み取り ---
// 公式 server と同じファイルを読むが 書き込みと退避 (.corrupt-<ts>) は公式の役割であり proxy は行わない
// 読み取り結果は outbound gate (reply の take over と進捗送信) と担当チャンネル解決で使う

export type GroupPolicy = { requireMention?: boolean; allowFrom?: string[] }

export type Access = {
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
}

function defaultAccess(): Access {
  return { allowFrom: [], groups: {} }
}

// access.json を 1 回読む
// 不在も解析不能も既定値 (allowFrom 空 / groups 空) として扱い 例外は投げない
export function readAccess(): Access {
  let parsed: Partial<Access>
  try {
    parsed = JSON.parse(readFileSync(join(stateDir(), 'access.json'), 'utf8')) as Partial<Access>
  } catch {
    return defaultAccess()
  }
  const a: Access = {
    allowFrom: Array.isArray(parsed.allowFrom) ? parsed.allowFrom : [],
    groups: typeof parsed.groups === 'object' && parsed.groups !== null ? parsed.groups : {},
  }
  if (parsed.replyToMode !== undefined) a.replyToMode = parsed.replyToMode
  if (parsed.textChunkLimit !== undefined) a.textChunkLimit = parsed.textChunkLimit
  if (parsed.chunkMode !== undefined) a.chunkMode = parsed.chunkMode
  return a
}

// プロセス単位の読み取り口を作る
// DISCORD_ACCESS_MODE=static のときは公式 server と同じく起動時の snapshot を固定し 以後再読込しない
// proxy と watcher は起動時刻が異なるため static では両者の snapshot が異なりうる (既知の制限)
export function createAccessReader(env: NodeJS.ProcessEnv = process.env): () => Access {
  if (env.DISCORD_ACCESS_MODE !== 'static') return readAccess
  const snapshot = readAccess()
  return () => snapshot
}

// outbound gate ---
// 公式 server の fetchAllowedChannel と同じ判定である
// ツールが送れる宛先を inbound gate が配送を許す宛先に一致させる
// DM チャンネル id と user id は別物のため 実体の recipients で相手を確かめる
// スレッドは親で判定し 親が無ければ自身の id で判定する (公式と同じ)
export function isAllowedTarget(access: Access, chatId: string, entity: ChannelEntity | null): boolean {
  if (!entity) return false
  if (entity.id !== chatId) return false
  if (entity.type === 1) {
    const userId = entity.recipients?.[0]?.id
    return typeof userId === 'string' && access.allowFrom.includes(userId)
  }
  const key = isThread(entity) && typeof entity.parent_id === 'string' ? entity.parent_id : chatId
  return Object.prototype.hasOwnProperty.call(access.groups, key)
}
