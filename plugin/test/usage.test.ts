import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ensureFresh,
  fetchUsageSnapshot,
  readAccessToken,
  readCachedWeekly,
  readModelUsage,
  refreshModelUsage,
  withCachedWeekly,
  type ModelUsageEntry,
} from '../src/usage'

// 一時ディレクトリ内のパスを作る (実キャッシュや実認証情報に触れないため)
const tmpFile = (name: string): string => join(mkdtempSync(join(tmpdir(), 'usage-')), name)

const writeJson = (path: string, value: unknown): void => {
  writeFileSync(path, JSON.stringify(value))
}
const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

const nowSec = (): number => Date.now() / 1000

// グローバル fetch を差し替えて元に戻す
async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = impl
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

const jsonResponse = (body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch

const WEEKLY_SCOPED = {
  kind: 'weekly_scoped',
  percent: 88,
  resets_at: '2026-08-23T02:59:59+00:00',
  scope: { model: { id: null, display_name: 'Fable' }, surface: null },
}

// --- readAccessToken ---

test('readAccessToken は有効期限内のトークンを返す', () => {
  const p = tmpFile('creds.json')
  writeJson(p, { claudeAiOauth: { accessToken: 'tok', expiresAt: Date.now() + 60_000 } })
  expect(readAccessToken(p)).toBe('tok')
})

test('readAccessToken は期限切れなら null を返す', () => {
  const p = tmpFile('creds.json')
  writeJson(p, { claudeAiOauth: { accessToken: 'tok', expiresAt: Date.now() - 1 } })
  expect(readAccessToken(p)).toBeNull()
})

test('readAccessToken は expiresAt が無ければトークンを返す', () => {
  const p = tmpFile('creds.json')
  writeJson(p, { claudeAiOauth: { accessToken: 'tok' } })
  expect(readAccessToken(p)).toBe('tok')
})

test('readAccessToken はファイルが無ければ null を返す', () => {
  expect(readAccessToken(tmpFile('absent.json'))).toBeNull()
})

test('readAccessToken は壊れた JSON でも null を返す', () => {
  const p = tmpFile('creds.json')
  writeFileSync(p, '{invalid')
  expect(readAccessToken(p)).toBeNull()
})

test('readAccessToken は claudeAiOauth が無ければ null を返す', () => {
  const p = tmpFile('creds.json')
  writeJson(p, { mcpOAuth: {} })
  expect(readAccessToken(p)).toBeNull()
})

// --- fetchUsageSnapshot ---

// スナップショットからモデル別枠だけを取り出す
const fetchEntries = async (token: string | null): Promise<ModelUsageEntry[] | null> => {
  const snap = await fetchUsageSnapshot(token)
  return snap === null ? null : snap.modelScoped
}

const WEEKLY_ALL = {
  kind: 'weekly_all',
  group: 'weekly',
  percent: 51,
  resets_at: '2026-08-23T02:59:59+00:00',
  scope: null,
}

test('fetchUsageSnapshot は weekly_all を 7d 全体として取り出す', async () => {
  const body = { limits: [WEEKLY_ALL, WEEKLY_SCOPED] }
  const snap = await withFetch(jsonResponse(body), () => fetchUsageSnapshot('tok'))
  // 1787453999 = 2026-08-23T02:59:59Z (プロダクションと同じ変換で導出しないためリテラルで書く)
  expect(snap?.weekly).toEqual({
    used_percentage: 51,
    resets_at: 1787453999,
  })
  expect(snap?.modelScoped).toHaveLength(1)
})

test('fetchUsageSnapshot は weekly_all が無ければ 7d 全体を null にする', async () => {
  const body = { limits: [WEEKLY_SCOPED] }
  const snap = await withFetch(jsonResponse(body), () => fetchUsageSnapshot('tok'))
  expect(snap?.weekly).toBeNull()
})

test('fetchUsageSnapshot はリセット時刻の無い weekly_all を採用しない', async () => {
  const body = { limits: [{ ...WEEKLY_ALL, resets_at: null }] }
  const snap = await withFetch(jsonResponse(body), () => fetchUsageSnapshot('tok'))
  expect(snap?.weekly).toBeNull()
})

test('fetchUsageSnapshot は weekly_scoped のモデル別枠だけを射影する', async () => {
  const body = {
    limits: [
      { kind: 'session', percent: 28, resets_at: null, scope: null },
      { kind: 'weekly_all', percent: 51, resets_at: null, scope: null },
      WEEKLY_SCOPED,
    ],
  }
  const got = await withFetch(jsonResponse(body), () => fetchEntries('tok'))
  expect(got).toEqual([
    {
      display_name: 'Fable',
      percent: 88,
      resets_at: 1787453999,
    },
  ])
})

test('fetchUsageSnapshot は複数の weekly_scoped を全て射影する', async () => {
  const second = {
    kind: 'weekly_scoped',
    percent: 12,
    resets_at: null,
    scope: { model: { id: null, display_name: 'Sonnet' }, surface: null },
  }
  const body = { limits: [WEEKLY_SCOPED, second] }
  const got = await withFetch(jsonResponse(body), () => fetchEntries('tok'))
  expect(got).toEqual([
    { display_name: 'Fable', percent: 88, resets_at: 1787453999 },
    { display_name: 'Sonnet', percent: 12, resets_at: null },
  ])
})

test('fetchUsageSnapshot は scope.model が無い要素を除外する', async () => {
  const body = {
    limits: [
      {
        kind: 'weekly_scoped',
        percent: 10,
        resets_at: null,
        scope: { model: null, surface: { display_name: 'Cowork' } },
      },
    ],
  }
  expect(await withFetch(jsonResponse(body), () => fetchEntries('tok'))).toEqual([])
})

test('fetchUsageSnapshot は resets_at が文字列でなければ null にする', async () => {
  const body = { limits: [{ ...WEEKLY_SCOPED, resets_at: null }] }
  const got = await withFetch(jsonResponse(body), () => fetchEntries('tok'))
  expect(got?.[0].resets_at).toBeNull()
})

test('fetchUsageSnapshot は limits が無ければ空配列を返す', async () => {
  expect(await withFetch(jsonResponse({ five_hour: null }), () => fetchEntries('tok'))).toEqual(
    [],
  )
})

test('fetchUsageSnapshot はトークンが無ければ HTTP を発行しない', async () => {
  let called = false
  const spy = (async () => {
    called = true
    return new Response('{}')
  }) as unknown as typeof fetch
  expect(await withFetch(spy, () => fetchEntries(null))).toBeNull()
  expect(called).toBe(false)
})

test('fetchUsageSnapshot は HTTP エラーなら null を返す', async () => {
  const err = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
  expect(await withFetch(err, () => fetchEntries('tok'))).toBeNull()
})

test('fetchUsageSnapshot は通信例外でも null を返す', async () => {
  const boom = (async () => {
    throw new Error('boom')
  }) as unknown as typeof fetch
  expect(await withFetch(boom, () => fetchEntries('tok'))).toBeNull()
})

// --- readModelUsage ---

test('readModelUsage はキャッシュのエントリを返す', () => {
  const p = tmpFile('cache.json')
  writeJson(p, { _cached_at: nowSec(), data: [{ display_name: 'Fable', percent: 88, resets_at: 123 }] })
  expect(readModelUsage(p)).toEqual([{ display_name: 'Fable', percent: 88, resets_at: 123 }])
})

test('readModelUsage はキャッシュが無ければ空配列を返す', () => {
  expect(readModelUsage(tmpFile('absent.json'))).toEqual([])
})

test('readModelUsage は percent が数値でない要素を除外する', () => {
  const p = tmpFile('cache.json')
  writeJson(p, { _cached_at: nowSec(), data: [{ display_name: 'Fable', percent: null }, 'junk'] })
  expect(readModelUsage(p)).toEqual([])
})

test('readModelUsage は取得時刻の無いキャッシュを使わない', () => {
  const p = tmpFile('cache.json')
  writeJson(p, { data: [{ display_name: 'Fable', percent: 88, resets_at: 123 }] })
  expect(readModelUsage(p)).toEqual([])
})

test('readModelUsage は STALE_SEC を超えて古いキャッシュを使わない', () => {
  const p = tmpFile('cache.json')
  writeJson(p, { _cached_at: nowSec() - 901, data: [{ display_name: 'Fable', percent: 88, resets_at: 123 }] })
  expect(readModelUsage(p)).toEqual([])
})

// --- refreshModelUsage ---

test('refreshModelUsage は週次値とモデル別枠と時刻を書き込む', async () => {
  const p = tmpFile('cache.json')
  const entries: ModelUsageEntry[] = [{ display_name: 'Fable', percent: 88, resets_at: null }]
  const weekly = { used_percentage: 51, resets_at: 1787454000 }
  await refreshModelUsage(p, async () => ({ weekly, modelScoped: entries }))
  const c = readJson(p)
  expect(c.data).toEqual(entries)
  expect(c.weekly).toEqual(weekly)
  expect(typeof c._cached_at).toBe('number')
  expect(typeof c._attempted_at).toBe('number')
})

test('refreshModelUsage は失敗時に既存データを保持し試行時刻だけ更新する', async () => {
  const p = tmpFile('cache.json')
  const kept = [{ display_name: 'Fable', percent: 88, resets_at: null }]
  const weekly = { used_percentage: 51, resets_at: 1787454000 }
  writeJson(p, { _cached_at: 100, _attempted_at: 100, data: kept, weekly })
  await refreshModelUsage(p, async () => null)
  const c = readJson(p)
  expect(c.data).toEqual(kept)
  expect(c.weekly).toEqual(weekly)
  expect(c._cached_at).toBe(100)
  expect(c._attempted_at as number).toBeGreaterThan(100)
})

// --- ensureFresh ---

test('ensureFresh は TTL 内なら更新を起動しない', () => {
  const p = tmpFile('cache.json')
  const now = nowSec()
  writeJson(p, { _cached_at: now, _attempted_at: now, data: [] })
  let spawned = false
  ensureFresh(p, () => {
    spawned = true
  })
  expect(spawned).toBe(false)
})

test('ensureFresh は TTL 切れなら更新を起動する', () => {
  const p = tmpFile('cache.json')
  writeJson(p, { _cached_at: 0, _attempted_at: 0, data: [] })
  let spawned = false
  ensureFresh(p, () => {
    spawned = true
  })
  expect(spawned).toBe(true)
})

test('ensureFresh は直近に試行済みなら起動しない', () => {
  const p = tmpFile('cache.json')
  writeJson(p, { _cached_at: 0, _attempted_at: nowSec(), data: [] })
  let spawned = false
  ensureFresh(p, () => {
    spawned = true
  })
  expect(spawned).toBe(false)
})

test('ensureFresh はキャッシュが無ければ起動する', () => {
  let spawned = false
  ensureFresh(tmpFile('absent.json'), () => {
    spawned = true
  })
  expect(spawned).toBe(true)
})

test('ensureFresh は起動前に試行時刻を記録して二重取得を防ぐ', () => {
  const p = tmpFile('cache.json')
  writeJson(p, { _cached_at: 0, _attempted_at: 0, data: [] })
  ensureFresh(p, () => {})
  expect(readJson(p)._attempted_at as number).toBeGreaterThan(0)

  // 記録済みなので続けて呼んでも起動しない
  let spawned = false
  ensureFresh(p, () => {
    spawned = true
  })
  expect(spawned).toBe(false)
})

test('ensureFresh は他プロセスがロック中なら起動しない', () => {
  const p = tmpFile('cache.json')
  writeJson(p, { _cached_at: 0, _attempted_at: 0, data: [] })
  writeFileSync(`${p}.lock`, '')
  let spawned = false
  ensureFresh(p, () => {
    spawned = true
  })
  expect(spawned).toBe(false)
  expect(readJson(p)._attempted_at).toBe(0)
})

test('ensureFresh は残置された古いロックを奪って起動する', () => {
  const p = tmpFile('cache.json')
  writeJson(p, { _cached_at: 0, _attempted_at: 0, data: [] })
  const lock = `${p}.lock`
  writeFileSync(lock, '')
  const stale = new Date(Date.now() - 31_000)
  utimesSync(lock, stale, stale)
  let spawned = false
  ensureFresh(p, () => {
    spawned = true
  })
  expect(spawned).toBe(true)
})

// --- 7d 全体の差し替え ---

const WEEKLY_CACHE = { used_percentage: 51, resets_at: 1787454000 }
const STDIN_DATA = {
  rate_limits: {
    five_hour: { used_percentage: 30, resets_at: 1787383200 },
    seven_day: { used_percentage: 99, resets_at: 1 },
  },
}

test('withCachedWeekly はキャッシュの週次値で seven_day を差し替える', () => {
  const p = tmpFile('cache.json')
  writeJson(p, { _cached_at: nowSec(), weekly: WEEKLY_CACHE })
  const got = withCachedWeekly(STDIN_DATA, p) as Record<string, Record<string, unknown>>
  expect(got.rate_limits.seven_day).toEqual(WEEKLY_CACHE)
})

test('withCachedWeekly は 5h を差し替えない', () => {
  const p = tmpFile('cache.json')
  writeJson(p, { _cached_at: nowSec(), weekly: WEEKLY_CACHE })
  const got = withCachedWeekly(STDIN_DATA, p) as Record<string, Record<string, unknown>>
  expect(got.rate_limits.five_hour).toEqual(STDIN_DATA.rate_limits.five_hour)
})

test('withCachedWeekly はキャッシュが無ければ元の data を返す', () => {
  expect(withCachedWeekly(STDIN_DATA, tmpFile('absent.json'))).toEqual(STDIN_DATA)
})

test('withCachedWeekly は STALE_SEC を超えて古いキャッシュなら元の data を返す', () => {
  const p = tmpFile('cache.json')
  writeJson(p, { _cached_at: nowSec() - 901, weekly: WEEKLY_CACHE })
  expect(withCachedWeekly(STDIN_DATA, p)).toEqual(STDIN_DATA)
})

test('withCachedWeekly は元の data を書き換えない', () => {
  const p = tmpFile('cache.json')
  writeJson(p, { _cached_at: nowSec(), weekly: WEEKLY_CACHE })
  withCachedWeekly(STDIN_DATA, p)
  expect(STDIN_DATA.rate_limits.seven_day.used_percentage).toBe(99)
})

test('withCachedWeekly は rate_limits が無ければ元の data を返す', () => {
  const p = tmpFile('cache.json')
  writeJson(p, { _cached_at: nowSec(), weekly: WEEKLY_CACHE })
  const d = { model: { display_name: 'Fable 5' } }
  expect(withCachedWeekly(d, p)).toEqual(d)
})

test('readCachedWeekly は値が不正なら null を返す', () => {
  const p = tmpFile('cache.json')
  writeJson(p, { _cached_at: nowSec(), weekly: { used_percentage: null, resets_at: 1 } })
  expect(readCachedWeekly(p)).toBeNull()
})

test('readCachedWeekly はキャッシュが無ければ null を返す', () => {
  expect(readCachedWeekly(tmpFile('absent.json'))).toBeNull()
})

test('readCachedWeekly は取得時刻の無いキャッシュを使わない', () => {
  const p = tmpFile('cache.json')
  writeJson(p, { weekly: WEEKLY_CACHE })
  expect(readCachedWeekly(p)).toBeNull()
})

test('readCachedWeekly は STALE_SEC を超えて古いキャッシュを使わない', () => {
  const p = tmpFile('cache.json')
  writeJson(p, { _cached_at: nowSec() - 901, weekly: WEEKLY_CACHE })
  expect(readCachedWeekly(p)).toBeNull()
})
