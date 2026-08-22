import { spawn } from 'child_process'
import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'

// モデル別週次枠 (Fable 等) の取得とキャッシュを担うモジュール
// statusline の stdin JSON にはモデル別の枠が含まれないため使用量 API から直接取る
// キャッシュ形式とパスは statusline と共有しており どちらが更新しても互いに読める
// 表示側 (status.ts) は読むだけで HTTP を発行せず 更新は常に別プロセスへ逃がす

type J = Record<string, unknown>
const obj = (v: unknown): J | null => (typeof v === 'object' && v !== null ? (v as J) : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export type ModelUsageEntry = {
  display_name: string
  percent: number
  resets_at: number | null
}

const API_URL = 'https://api.anthropic.com/api/oauth/usage'
const API_TIMEOUT_MS = 5_000
const TTL_SEC = 300 // statusline 側の TTL と揃える
const RETRY_SEC = 60 // 取得失敗時に再試行を抑制する間隔

export const usageCachePath = (): string => join(tmpdir(), 'claude-model-usage.json')
const credentialsPath = (): string => join(homedir(), '.claude', '.credentials.json')

const nowSec = (): number => Date.now() / 1000

// キャッシュを読む (無い・壊れている場合は空オブジェクト)
function readCache(path: string): J {
  try {
    return obj(JSON.parse(readFileSync(path, 'utf8'))) ?? {}
  } catch {
    return {}
  }
}

// 同時読み取りに壊れたファイルを見せないため一時ファイル経由で置き換える
function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
}

// statusline と同じ `<path>.lock` 方式で read-modify-write を直列化する
// 取得できない場合も処理は続行する (可用性を優先し stale lock でも停止しない)
function withLock<T>(path: string, fn: () => T): T {
  const lockPath = `${path}.lock`
  let fd: number | null = null
  try {
    fd = openSync(lockPath, 'wx')
  } catch {
    fd = null
  }
  try {
    return fn()
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // クローズ失敗は無視する
      }
      try {
        unlinkSync(lockPath)
      } catch {
        // 既に消えている場合は無視する
      }
    }
  }
}

// 認証情報から有効な access token を読む
// 期限切れなら null を返す (リフレッシュは Claude Code 本体の責務であり競合させない)
export function readAccessToken(path = credentialsPath()): string | null {
  try {
    const o = obj(obj(JSON.parse(readFileSync(path, 'utf8')))?.claudeAiOauth)
    if (!o) return null
    const token = o.accessToken
    if (typeof token !== 'string' || !token) return null
    const expiresAt = num(o.expiresAt)
    if (expiresAt !== null && expiresAt <= Date.now()) return null
    return token
  } catch {
    return null
  }
}

// limits 配列の1要素をモデル別枠へ変換する
// weekly_scoped かつ scope.model を持つ要素だけを対象とする
function toEntry(item: unknown): ModelUsageEntry | null {
  const o = obj(item)
  if (!o || o.kind !== 'weekly_scoped') return null
  const name = obj(obj(o.scope)?.model)?.display_name
  const percent = num(o.percent)
  if (typeof name !== 'string' || !name || percent === null) return null
  const iso = typeof o.resets_at === 'string' ? Date.parse(o.resets_at) : Number.NaN
  return {
    display_name: name,
    percent,
    resets_at: Number.isFinite(iso) ? iso / 1000 : null,
  }
}

// 使用量 API からモデル別の週次枠を取得する (失敗時は null)
export async function fetchModelUsage(token = readAccessToken()): Promise<ModelUsageEntry[] | null> {
  if (!token) return null
  try {
    const res = await fetch(API_URL, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const limits = obj(await res.json())?.limits
    if (!Array.isArray(limits)) return []
    return limits.map(toEntry).filter((e): e is ModelUsageEntry => e !== null)
  } catch {
    return null
  }
}

// キャッシュからモデル別枠を読む (表示側が使う経路で HTTP は発行しない)
export function readModelUsage(path = usageCachePath()): ModelUsageEntry[] {
  const data = readCache(path).data
  if (!Array.isArray(data)) return []
  return data.map(toStoredEntry).filter((e): e is ModelUsageEntry => e !== null)
}

// キャッシュに保存済みのエントリを読み戻す (API 応答とは形が違うため別に扱う)
function toStoredEntry(item: unknown): ModelUsageEntry | null {
  const o = obj(item)
  if (!o) return null
  const name = o.display_name
  const percent = num(o.percent)
  if (typeof name !== 'string' || !name || percent === null) return null
  return { display_name: name, percent, resets_at: num(o.resets_at) }
}

// API を取得してキャッシュを更新する (別プロセスから呼ばれる想定)
// 失敗時も試行時刻だけ記録し既存データは保持する
export async function refreshModelUsage(
  path = usageCachePath(),
  fetchFn = fetchModelUsage,
): Promise<void> {
  const entries = await fetchFn()
  const now = nowSec()
  withLock(path, () => {
    const cache = readCache(path)
    cache._attempted_at = now
    if (entries !== null) {
      cache._cached_at = now
      cache.data = entries
    }
    writeAtomic(path, JSON.stringify(cache))
  })
}

// 更新用の子プロセスをデタッチして起動する
function spawnRefresh(): void {
  try {
    const child = spawn(process.execPath, [import.meta.path], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
  } catch {
    // 起動できなくても表示は継続する
  }
}

// キャッシュが古ければ更新を別プロセスへ依頼する
// 結果は待たず次回の描画へ反映する (statusline の表示を遅延させないため)
// 起動前に試行時刻を記録し statusline 側との二重取得を防ぐ
export function ensureFresh(path = usageCachePath(), spawnFn = spawnRefresh): void {
  const cache = readCache(path)
  const now = nowSec()
  const hasData = Array.isArray(cache.data)
  if (hasData && now - (num(cache._cached_at) ?? 0) < TTL_SEC) return
  if (now - (num(cache._attempted_at) ?? 0) < RETRY_SEC) return

  withLock(path, () => {
    const latest = readCache(path)
    latest._attempted_at = now
    writeAtomic(path, JSON.stringify(latest))
  })
  spawnFn()
}

// 直接実行されたときはキャッシュ更新のみ行う (spawnRefresh の実体)
if (import.meta.main) {
  await refreshModelUsage()
}
