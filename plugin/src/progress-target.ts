import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { isHex32, isSessionId, isSnowflake, resolveInDir } from './ids'
import { stateDir } from './routes'

// 進捗の宛先ファイル ---
// 本体 (progress-thread/<owner>) は素の id 1 行で 旧 notify と旧 archive のためだけに書く
// 宛先 (progress-thread/<owner>.<activation_id>.meta) は activation 単位で 新 notify と新 archive が読む
// activation が違えば別ファイルになるため 同じ session_id を別プロセスから同時に resume しても互いを上書きしない

// 宛先の有効期間 (滞留スレッド archive と同じ閾値)
export const TARGET_TTL_MS = 12 * 60 * 60 * 1000

export type ProgressTarget = {
  id: string
  parent: string
  kind: 'guild' | 'dm'
  session_id: string
  run_id: string
  activation_id: string
  message_id: string
  written_at: number
}

export function progressDir(): string {
  return join(stateDir(), 'progress-thread')
}

// 正規化済みの担当名だけを受け付ける (routes.ts と同じ契約)
function isOwner(owner: string): boolean {
  return /^[a-z0-9-]+$/.test(owner)
}

function targetPath(owner: string, activationId: string): string | null {
  if (!isOwner(owner) || !isHex32(activationId)) return null
  return resolveInDir(progressDir(), `${owner}.${activationId}.meta`)
}

function bodyPath(owner: string): string | null {
  if (!isOwner(owner)) return null
  return resolveInDir(progressDir(), owner)
}

// 一時ファイルへ書いてから rename する (途中状態を reader に見せない)
function writeAtomic(path: string, content: string): boolean {
  try {
    mkdirSync(progressDir(), { recursive: true, mode: 0o700 })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}

// 宛先の構文検証
// ファイル名の activation_id と内容の activation_id の一致まで確認する
function parseTarget(raw: string, activationId: string): ProgressTarget | null {
  let v: Record<string, unknown>
  try {
    v = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
  if (v.activation_id !== activationId) return null
  if (!isSnowflake(v.id) || !isSnowflake(v.parent) || !isSnowflake(v.message_id)) return null
  if (v.kind !== 'guild' && v.kind !== 'dm') return null
  if (!isSessionId(v.session_id)) return null
  if (!isHex32(v.run_id)) return null
  if (typeof v.written_at !== 'number' || !Number.isFinite(v.written_at)) return null
  return {
    id: v.id,
    parent: v.parent,
    kind: v.kind,
    session_id: v.session_id,
    run_id: v.run_id,
    activation_id: activationId,
    message_id: v.message_id,
    written_at: v.written_at,
  }
}

// 宛先を読む
// 構文検証だけを行い 期限は見ない (archive は期限切れの宛先も id 一致で削除する)
export function readTarget(owner: string, activationId: string): ProgressTarget | null {
  const path = targetPath(owner, activationId)
  if (!path) return null
  try {
    return parseTarget(readFileSync(path, 'utf8'), activationId)
  } catch {
    return null
  }
}

export function writeTarget(owner: string, t: ProgressTarget): boolean {
  const path = targetPath(owner, t.activation_id)
  if (!path) return false
  return writeAtomic(path, JSON.stringify(t))
}

export function deleteTarget(owner: string, activationId: string): boolean {
  const path = targetPath(owner, activationId)
  if (!path) return false
  try {
    rmSync(path, { force: true })
    return true
  } catch {
    return false
  }
}

// notify 用の有効判定
// 宛先の activation が watcher の activation と一致し 期限内であることを要求する
// この後 送信直前に activation の再確認と outbound gate を適用する
export function isActiveFor(t: ProgressTarget, activationId: string, now: number = Date.now()): boolean {
  if (t.activation_id !== activationId) return false
  const age = now - t.written_at
  return age >= 0 && age <= TARGET_TTL_MS
}

// 同じ担当の宛先を列挙する
// 担当解決の周期 proxy の終了処理 archive がまとめて操作するために使う
export function listTargets(owner: string): Array<{ activationId: string; target: ProgressTarget }> {
  if (!isOwner(owner)) return []
  let names: string[]
  try {
    names = readdirSync(progressDir())
  } catch {
    return []
  }
  const out: Array<{ activationId: string; target: ProgressTarget }> = []
  const re = new RegExp(`^${owner}\\.([0-9a-f]{32})\\.meta$`)
  for (const name of names) {
    const m = re.exec(name)
    if (!m) continue
    const t = readTarget(owner, m[1])
    if (t) out.push({ activationId: m[1], target: t })
  }
  return out
}

// 本体 (旧 reader との契約) ---
// 旧 notify は progressChannelId() でファイル全体を宛先 id として読む
// 新 reader は読まないが 移行期間は書き続ける

export function writeProgressBody(owner: string, id: string): boolean {
  const path = bodyPath(owner)
  if (!path || !isSnowflake(id)) return false
  return writeAtomic(path, id)
}

export function readProgressBody(owner: string): string | null {
  const path = bodyPath(owner)
  if (!path) return null
  try {
    const v = readFileSync(path, 'utf8').trim()
    return v || null
  } catch {
    return null
  }
}
