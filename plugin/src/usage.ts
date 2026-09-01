import { spawn } from 'child_process'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { stateDir } from './routes'

// モデル別週次枠 (Fable 等) の取得とキャッシュを担うモジュール
// statusline の stdin JSON にはモデル別の枠が含まれないため使用量 API から直接取る
// キャッシュは cc-discord 専用で statusline 側とは一切共有しない (相互に依存させない)
// 表示側 (status.ts) は読むだけで HTTP を発行せず 更新は常に別プロセスへ逃がす

type J = Record<string, unknown>
const obj = (v: unknown): J | null => (typeof v === 'object' && v !== null ? (v as J) : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export type ModelUsageEntry = {
  display_name: string
  percent: number
  resets_at: number | null
}

// 7d 全体のバケット (statusline JSON の rate_limits.seven_day と同じ形)
export type WeeklyBucket = {
  used_percentage: number
  resets_at: number
}

// 使用量 API から一度に取り出した週次の使用状況
// 7d 全体とモデル別枠を同じ応答から取ることで表示時点を揃える
export type UsageSnapshot = {
  weekly: WeeklyBucket | null
  modelScoped: ModelUsageEntry[]
}

const API_URL = 'https://api.anthropic.com/api/oauth/usage'
const API_TIMEOUT_MS = 5_000
const TTL_SEC = 300 // キャッシュの保持時間
const RETRY_SEC = 60 // 取得失敗時に再試行を抑制する間隔
const STALE_SEC = 900 // この時間を超えて更新できていないキャッシュは表示に使わない
const LOCK_STALE_MS = 30_000 // これより古いロックは異常終了の残置とみなして奪う

export const usageCachePath = (): string => join(stateDir(), 'model-usage.json')

// 認証情報の場所 (CLAUDE_CONFIG_DIR を使う分離プロファイルにも追随する)
export const credentialsPath = (): string =>
  join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), '.credentials.json')

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
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
}

// ロックを排他的に作る (取れなければ null)
// 異常終了で残ったロックは LOCK_STALE_MS を過ぎたら奪い 更新が恒久的に止まるのを避ける
function acquireLock(lockPath: string): number | null {
  try {
    return openSync(lockPath, 'wx')
  } catch {
    // 既存ロックがあるので寿命を見て奪えるか判断する
  }
  try {
    if (Date.now() - statSync(lockPath).mtimeMs <= LOCK_STALE_MS) return null
    // 回収はいったん自分専用の名前へ rename して行う
    // 成功するのは 1 プロセスだけなので 検査後に張り直された他プロセスのロックを消す危険がない
    const claimed = `${lockPath}.${process.pid}.stale`
    renameSync(lockPath, claimed)
    unlinkSync(claimed)
    return openSync(lockPath, 'wx')
  } catch {
    return null
  }
}

// `<path>.lock` を使って read-modify-write を直列化する
// 取得できない場合も fn は locked=false で呼ぶ (可用性を優先し書き込み自体は止めない)
// 排他が要る処理は locked を見て自分が唯一の実行者かを判断する
function withLock<T>(path: string, fn: (locked: boolean) => T): T {
  const lockPath = `${path}.lock`
  const fd = acquireLock(lockPath)
  try {
    return fn(fd !== null)
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

// limits 配列の1要素を 7d 全体のバケットへ変換する
// kind が weekly_all の要素だけを対象とし リセット時刻が無いものは表示できないため除く
function toWeeklyBucket(item: unknown): WeeklyBucket | null {
  const o = obj(item)
  if (!o || o.kind !== 'weekly_all') return null
  const percent = num(o.percent)
  const iso = typeof o.resets_at === 'string' ? Date.parse(o.resets_at) : Number.NaN
  if (percent === null || !Number.isFinite(iso)) return null
  return { used_percentage: percent, resets_at: iso / 1000 }
}

// 使用量 API から週次の使用状況を取得する (失敗時は null)
// 7d 全体も同じ応答から取り出し 括弧内の内訳と表示時点を揃える
export async function fetchUsageSnapshot(
  token = readAccessToken(),
): Promise<UsageSnapshot | null> {
  if (!token) return null
  try {
    const res = await fetch(API_URL, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const limits = obj(await res.json())?.limits
    if (!Array.isArray(limits)) return { weekly: null, modelScoped: [] }

    let weekly: WeeklyBucket | null = null
    const modelScoped: ModelUsageEntry[] = []
    for (const item of limits) {
      const entry = toEntry(item)
      if (entry !== null) {
        modelScoped.push(entry)
      } else if (weekly === null) {
        weekly = toWeeklyBucket(item)
      }
    }
    return { weekly, modelScoped }
  } catch {
    return null
  }
}

// 最後に取得できてから STALE_SEC 以内かを判定する
// 認証切れなどで更新が止まった際に古い値を出し続けないための足切りである
function isFresh(cache: J): boolean {
  const cachedAt = num(cache._cached_at)
  return cachedAt !== null && nowSec() - cachedAt < STALE_SEC
}

// キャッシュからモデル別枠を読む (表示側が使う経路で HTTP は発行しない)
export function readModelUsage(path = usageCachePath()): ModelUsageEntry[] {
  const cache = readCache(path)
  if (!isFresh(cache)) return []
  const data = cache.data
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
  fetchFn = fetchUsageSnapshot,
): Promise<void> {
  const snapshot = await fetchFn()
  const now = nowSec()
  withLock(path, () => {
    const cache = readCache(path)
    cache._attempted_at = now
    if (snapshot !== null) {
      cache._cached_at = now
      cache.data = snapshot.modelScoped
      cache.weekly = snapshot.weekly
    }
    writeAtomic(path, JSON.stringify(cache))
  })
}

// キャッシュの 7d 全体を読む (無い・古すぎる場合は null)
export function readCachedWeekly(path = usageCachePath()): WeeklyBucket | null {
  const cache = readCache(path)
  if (!isFresh(cache)) return null
  const w = obj(cache.weekly)
  if (!w) return null
  const percent = num(w.used_percentage)
  const resets = num(w.resets_at)
  if (percent === null || resets === null) return null
  return { used_percentage: percent, resets_at: resets }
}

// rate_limits.seven_day をキャッシュの週次値へ差し替える
// 括弧内のモデル別枠と同じ取得時点の値を並べるためである
// キャッシュに週次の値が無い または古すぎる場合は元の data をそのまま返す
export function withCachedWeekly(data: J, path = usageCachePath()): J {
  const weekly = readCachedWeekly(path)
  const rl = obj(data.rate_limits)
  if (weekly === null || rl === null) return data
  return { ...data, rate_limits: { ...rl, seven_day: weekly } }
}

// 更新用の子プロセスをデタッチして起動する
function spawnRefresh(): void {
  try {
    // windowsHide は Windows で更新のたびにコンソール窓が現れるのを抑止する
    const child = spawn(process.execPath, [import.meta.path], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
  } catch {
    // 起動できなくても表示は継続する
  }
}

// 更新が不要なキャッシュかを判定する
// 保持時間内のデータがある もしくは直近に取得を試みたばかりの場合は再取得しない
function isCacheCurrent(cache: J): boolean {
  const now = nowSec()
  if (Array.isArray(cache.data) && now - (num(cache._cached_at) ?? 0) < TTL_SEC) return true
  return now - (num(cache._attempted_at) ?? 0) < RETRY_SEC
}

// キャッシュが古ければ更新を別プロセスへ依頼する
// 結果は待たず次回の描画へ反映する (statusline の表示を遅延させないため)
// 起動判断と試行時刻の記録をロック内で行い 同時に走る tee プロセス間での二重取得を防ぐ
// ロックを取れなかった側は他プロセスが起動したとみなして何もしない
export function ensureFresh(path = usageCachePath(), spawnFn = spawnRefresh): void {
  if (isCacheCurrent(readCache(path))) return

  const won = withLock(path, (locked) => {
    if (!locked) return false
    // ロックを取るまでの間に別プロセスが試行済みなら起動しない
    const latest = readCache(path)
    if (isCacheCurrent(latest)) return false
    latest._attempted_at = nowSec()
    writeAtomic(path, JSON.stringify(latest))
    return true
  })
  if (won) spawnFn()
}

// 直接実行されたときはキャッシュ更新のみ行う (spawnRefresh の実体)
if (import.meta.main) {
  await refreshModelUsage()
}
