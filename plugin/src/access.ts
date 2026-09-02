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

// 送信設定の既知の値
// 公式 server の既定に合わせ 未知の値と型違いは無かったものとして扱う
const REPLY_TO_MODES = new Set(['off', 'first', 'all'])
const CHUNK_MODES = new Set(['length', 'newline'])

// access.json を 1 回読む
// 不在も解析不能も既定値 (allowFrom 空 / groups 空) として扱い 例外は投げない
// 値はすべて実行時に検証する (型注釈は JSON の中身を保証しない)
export function readAccess(): Access {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(readFileSync(join(stateDir(), 'access.json'), 'utf8')) as Record<string, unknown>
  } catch {
    return defaultAccess()
  }
  if (typeof parsed !== 'object' || parsed === null) return defaultAccess()

  const a: Access = {
    allowFrom: Array.isArray(parsed.allowFrom) ? parsed.allowFrom.filter((v): v is string => typeof v === 'string') : [],
    groups:
      typeof parsed.groups === 'object' && parsed.groups !== null
        ? (parsed.groups as Record<string, GroupPolicy>)
        : {},
  }
  if (typeof parsed.replyToMode === 'string' && REPLY_TO_MODES.has(parsed.replyToMode)) {
    a.replyToMode = parsed.replyToMode as Access['replyToMode']
  }
  if (typeof parsed.textChunkLimit === 'number' && Number.isFinite(parsed.textChunkLimit)) {
    a.textChunkLimit = parsed.textChunkLimit
  }
  if (typeof parsed.chunkMode === 'string' && CHUNK_MODES.has(parsed.chunkMode)) {
    a.chunkMode = parsed.chunkMode as Access['chunkMode']
  }
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
