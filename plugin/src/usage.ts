import { spawn } from 'child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
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

// 一時点の週次の使用状況 (7d 全体とモデル別枠の組)
// API 応答からもキャッシュからも常にこの組で受け渡し 表示時点を揃える
export type UsageSnapshot = {
  weekly: WeeklyBucket | null
  modelScoped: ModelUsageEntry[]
}

const API_URL = 'https://api.anthropic.com/api/oauth/usage'
const API_TIMEOUT_MS = 5_000
const TTL_SEC = 300 // キャッシュの保持時間
const RETRY_SEC = 60 // 取得失敗時に再試行を抑制する間隔
const STALE_SEC = 900 // この時間を超えて更新できていないキャッシュは表示に使わない

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

// キャッシュの data 配列をモデル別枠へ変換する
function toStoredEntries(data: unknown): ModelUsageEntry[] {
  if (!Array.isArray(data)) return []
  return data.map(toStoredEntry).filter((e): e is ModelUsageEntry => e !== null)
}

// キャッシュの weekly を 7d 全体のバケットへ変換する
function toStoredWeekly(value: unknown): WeeklyBucket | null {
  const w = obj(value)
  if (!w) return null
  const percent = num(w.used_percentage)
  const resets = num(w.resets_at)
  if (percent === null || resets === null) return null
  return { used_percentage: percent, resets_at: resets }
}

// キャッシュを1回だけ読んで 7d 全体とモデル別枠をまとめて取り出す
// 表示側が使う経路で HTTP は発行しない
// 1回の描画で両方をこの結果から導出することで 描画途中の更新による時点のずれを避ける
// 古すぎるキャッシュは両方とも捨てる (片方だけ古い値を混ぜないため)
export function readCachedUsage(path = usageCachePath()): UsageSnapshot {
  const cache = readCache(path)
  if (!isFresh(cache)) return { weekly: null, modelScoped: [] }
  return { weekly: toStoredWeekly(cache.weekly), modelScoped: toStoredEntries(cache.data) }
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
// 同時に走った更新どうしは互いを上書きしうるが どちらも同時点のスナップショットなので害はない
export async function refreshModelUsage(
  path = usageCachePath(),
  fetchFn = fetchUsageSnapshot,
): Promise<void> {
  const snapshot = await fetchFn()
  const now = nowSec()
  const cache = readCache(path)
  cache._attempted_at = now
  if (snapshot !== null) {
    cache._cached_at = now
    cache.data = snapshot.modelScoped
    cache.weekly = snapshot.weekly
  }
  writeAtomic(path, JSON.stringify(cache))
}

// rate_limits.seven_day を与えられた週次値へ差し替える
// 括弧内のモデル別枠と同じ取得時点の値を並べるためである
// 週次の値が無ければ元の data をそのまま返す
export function withCachedWeekly(data: J, weekly: WeeklyBucket | null): J {
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
// 起動前に試行時刻を記録し 後続の描画が RETRY_SEC の間は再依頼しないようにする
// 同時刻に走った tee プロセスどうしは重複して依頼しうるが 余分な取得が1回増えるだけで実害は無い
// キャッシュを書けない場合も例外は外へ出さない (補助的な更新で呼び出し元の描画を止めないため)
export function ensureFresh(path = usageCachePath(), spawnFn = spawnRefresh): void {
  try {
    const cache = readCache(path)
    if (isCacheCurrent(cache)) return
    cache._attempted_at = nowSec()
    writeAtomic(path, JSON.stringify(cache))
    spawnFn()
  } catch {
    // 更新を依頼できなくても次回の描画で再試行される
  }
}

// 直接実行されたときはキャッシュ更新のみ行う (spawnRefresh の実体)
if (import.meta.main) {
  await refreshModelUsage()
}
