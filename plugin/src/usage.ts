import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { stateDir } from './routes'

// 5h と 7d とモデル別週次枠 (Fable 等) の取得とキャッシュを担うモジュール
// statusline の stdin JSON にはモデル別の枠が含まれないため使用量 API から直接取る
// キャッシュは cc-discord 専用で statusline 側とは一切共有しない (相互に依存させない)
// キャッシュは直近に試行済みのときと取得に失敗したときの代わりに使う

type J = Record<string, unknown>
const obj = (v: unknown): J | null => (typeof v === 'object' && v !== null ? (v as J) : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export type ModelUsageEntry = {
  display_name: string
  percent: number
  resets_at: number | null
}

// 使用量の 1 バケット (statusline JSON の rate_limits.five_hour / seven_day と同じ形)
export type RateBucket = {
  used_percentage: number
  resets_at: number
}

// 一時点の使用状況 (5h と 7d 全体とモデル別枠の組)
// API 応答からもキャッシュからも常にこの組で受け渡し 表示時点を揃える
export type UsageSnapshot = {
  weekly: RateBucket | null
  session: RateBucket | null
  modelScoped: ModelUsageEntry[]
}

const API_URL = 'https://api.anthropic.com/api/oauth/usage'
// reply の送信を待たせる上限
const API_TIMEOUT_MS = 3_000
// 試行の間隔の下限 (全セッションでキャッシュを介して共有する)
// 使用量 API は Claude Code 本体や statusline と上限を共有しており 短い間隔で呼ぶと 429 を返す
const MIN_ATTEMPT_INTERVAL_SEC = 60

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

// limits 配列の1要素を指定した種類のバケットへ変換する
// 7d 全体は kind が weekly_all 5h は kind が session の要素を対象とし
// リセット時刻が無いものは表示できないため除く
function toRateBucket(item: unknown, kind: string): RateBucket | null {
  const o = obj(item)
  if (!o || o.kind !== kind) return null
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
    if (!Array.isArray(limits)) return { weekly: null, session: null, modelScoped: [] }

    let weekly: RateBucket | null = null
    let session: RateBucket | null = null
    const modelScoped: ModelUsageEntry[] = []
    for (const item of limits) {
      const entry = toEntry(item)
      if (entry !== null) {
        modelScoped.push(entry)
        continue
      }
      weekly ??= toRateBucket(item, 'weekly_all')
      session ??= toRateBucket(item, 'session')
    }
    return { weekly, session, modelScoped }
  } catch {
    return null
  }
}

// リセット時刻を過ぎたかを判定する (過ぎた枠の値はもう正しくない)
const hasReset = (resetsAt: number | null): boolean => resetsAt !== null && resetsAt <= nowSec()

// キャッシュの data 配列をモデル別枠へ変換する
function toStoredEntries(data: unknown): ModelUsageEntry[] {
  if (!Array.isArray(data)) return []
  return data.map(toStoredEntry).filter((e): e is ModelUsageEntry => e !== null)
}

// キャッシュに保存済みのバケットを読み戻す
function toStoredBucket(value: unknown): RateBucket | null {
  const w = obj(value)
  if (!w) return null
  const percent = num(w.used_percentage)
  const resets = num(w.resets_at)
  if (percent === null || resets === null || hasReset(resets)) return null
  return { used_percentage: percent, resets_at: resets }
}

// キャッシュを 1 回だけ読んで 7d 全体とモデル別枠をまとめて取り出す
// 取得しないときの代わりに使う経路で HTTP は発行しない
// 1 回の描画で両方をこの結果から導出することで 描画途中の更新による時点のずれを避ける
// 取得から時間が経っていても最後に取得できた値を返し リセット時刻を過ぎた枠だけを省く
export function readCachedUsage(path = usageCachePath()): UsageSnapshot {
  const cache = readCache(path)
  return {
    weekly: toStoredBucket(cache.weekly),
    session: toStoredBucket(cache.session),
    modelScoped: toStoredEntries(cache.data),
  }
}

// キャッシュに保存済みのエントリを読み戻す (API 応答とは形が違うため別に扱う)
function toStoredEntry(item: unknown): ModelUsageEntry | null {
  const o = obj(item)
  if (!o) return null
  const name = o.display_name
  const percent = num(o.percent)
  const resets = num(o.resets_at)
  if (typeof name !== 'string' || !name || percent === null || hasReset(resets)) return null
  return { display_name: name, percent, resets_at: resets }
}

// キャッシュを書き 書けたかを返す
function writeCache(path: string, cache: J): boolean {
  try {
    writeAtomic(path, JSON.stringify(cache))
    return true
  } catch {
    return false
  }
}

// 直近に試行済みかを判定する (未来の時刻は不正な値とみなして無視する)
function attemptedRecently(cache: J): boolean {
  const elapsed = nowSec() - (num(cache._attempted_at) ?? 0)
  return elapsed >= 0 && elapsed < MIN_ATTEMPT_INTERVAL_SEC
}

// 使用量 API から現時点の値を取得してキャッシュへ書く
// 直近に試行済みのときと取得に失敗したときはキャッシュの値を返す
export async function currentUsage(
  path = usageCachePath(),
  fetchFn: () => Promise<UsageSnapshot | null> = () => fetchUsageSnapshot(),
): Promise<UsageSnapshot> {
  const cache = readCache(path)
  if (attemptedRecently(cache)) return readCachedUsage(path)
  // 並走するセッションの重複した取得を減らすため 取得の前に試行時刻を記録する
  // 記録できなければ 60 秒の下限を守れないため取得しない
  const attemptedAt = nowSec()
  if (!writeCache(path, { ...cache, _attempted_at: attemptedAt })) return readCachedUsage(path)
  const snapshot = await fetchFn()
  if (snapshot === null) return readCachedUsage(path)
  // 取得後の書き込みに失敗しても今回の表示には影響しない
  writeCache(path, {
    _attempted_at: attemptedAt,
    _cached_at: nowSec(),
    data: snapshot.modelScoped,
    weekly: snapshot.weekly,
    session: snapshot.session,
  })
  return snapshot
}
