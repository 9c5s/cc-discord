import { test, expect } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import {
  credentialsPath,
  ensureFresh,
  fetchUsageSnapshot,
  readAccessToken,
  readCachedUsage,
  refreshModelUsage,
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

// 環境変数を差し替えて元に戻す
function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const original = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    return fn()
  } finally {
    if (original === undefined) delete process.env[name]
    else process.env[name] = original
  }
}

// --- credentialsPath ---

test('credentialsPath は CLAUDE_CONFIG_DIR 配下を指す', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'))
  expect(withEnv('CLAUDE_CONFIG_DIR', dir, credentialsPath)).toBe(join(dir, '.credentials.json'))
})

test('credentialsPath は CLAUDE_CONFIG_DIR が無ければホーム配下の .claude を指す', () => {
  expect(withEnv('CLAUDE_CONFIG_DIR', undefined, credentialsPath)).toBe(
    join(homedir(), '.claude', '.credentials.json'),
  )
})

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

const SESSION_LIMIT = {
  kind: 'session',
  group: 'session',
  percent: 63,
  resets_at: '2026-08-23T06:00:00+00:00',
  scope: null,
}

test('fetchUsageSnapshot は session を 5h として取り出す', async () => {
  const body = { limits: [SESSION_LIMIT, WEEKLY_ALL, WEEKLY_SCOPED] }
  const snap = await withFetch(jsonResponse(body), () => fetchUsageSnapshot('tok'))
  // 1787464800 = 2026-08-23T06:00:00Z (プロダクションと同じ変換で導出しないためリテラルで書く)
  expect(snap?.session).toEqual({ used_percentage: 63, resets_at: 1787464800 })
})

test('fetchUsageSnapshot は session が無ければ 5h を null にする', async () => {
  const body = { limits: [WEEKLY_ALL] }
  const snap = await withFetch(jsonResponse(body), () => fetchUsageSnapshot('tok'))
  expect(snap?.session).toBeNull()
})

test('fetchUsageSnapshot はリセット時刻の無い session を採用しない', async () => {
  const body = { limits: [{ ...SESSION_LIMIT, resets_at: null }] }
  const snap = await withFetch(jsonResponse(body), () => fetchUsageSnapshot('tok'))
  expect(snap?.session).toBeNull()
})

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

// --- readCachedUsage ---

const FABLE_ENTRY = { display_name: 'Fable', percent: 88, resets_at: 123 }
const WEEKLY_STORED = { used_percentage: 51, resets_at: 1787454000 }

const SESSION_STORED = { used_percentage: 63, resets_at: 1787464800 }

test('readCachedUsage は 5h と 7d 全体とモデル別枠を1回の読み取りで返す', () => {
  const p = tmpFile('cache.json')
  writeJson(p, { _cached_at: nowSec(), data: [FABLE_ENTRY], weekly: WEEKLY_STORED, session: SESSION_STORED })
  expect(readCachedUsage(p)).toEqual({
    weekly: WEEKLY_STORED,
    session: SESSION_STORED,
    modelScoped: [FABLE_ENTRY],
  })
})

test('readCachedUsage は session の値が不正なら null にする', () => {
  const p = tmpFile('cache.json')
  writeJson(p, { _cached_at: nowSec(), session: { used_percentage: null, resets_at: 1 } })
  expect(readCachedUsage(p).session).toBeNull()
})

test('readCachedUsage はキャッシュが無ければ空の組を返す', () => {
  expect(readCachedUsage(tmpFile('absent.json'))).toEqual({ weekly: null, session: null, modelScoped: [] })
})

test('readCachedUsage は壊れた JSON でも空の組を返す', () => {
  const p = tmpFile('cache.json')
  writeFileSync(p, '{invalid')
  expect(readCachedUsage(p)).toEqual({ weekly: null, session: null, modelScoped: [] })
})

test('readCachedUsage は percent が数値でない要素を除外する', () => {
  const p = tmpFile('cache.json')
  writeJson(p, { _cached_at: nowSec(), data: [{ display_name: 'Fable', percent: null }, 'junk'] })
  expect(readCachedUsage(p).modelScoped).toEqual([])
})

test('readCachedUsage は weekly の値が不正なら null にする', () => {
  const p = tmpFile('cache.json')
  writeJson(p, { _cached_at: nowSec(), weekly: { used_percentage: null, resets_at: 1 } })
  expect(readCachedUsage(p).weekly).toBeNull()
})

test('readCachedUsage は取得時刻の無いキャッシュを使わない', () => {
  const p = tmpFile('cache.json')
  writeJson(p, { data: [FABLE_ENTRY], weekly: WEEKLY_STORED, session: SESSION_STORED })
  expect(readCachedUsage(p)).toEqual({ weekly: null, session: null, modelScoped: [] })
})

test('readCachedUsage は STALE_SEC を超えて古いキャッシュをすべて捨てる', () => {
  const p = tmpFile('cache.json')
  writeJson(p, { _cached_at: nowSec() - 901, data: [FABLE_ENTRY], weekly: WEEKLY_STORED, session: SESSION_STORED })
  expect(readCachedUsage(p)).toEqual({ weekly: null, session: null, modelScoped: [] })
})

// --- refreshModelUsage ---

test('refreshModelUsage は週次値とモデル別枠と時刻を書き込む', async () => {
  const p = tmpFile('cache.json')
  const entries: ModelUsageEntry[] = [{ display_name: 'Fable', percent: 88, resets_at: null }]
  const weekly = { used_percentage: 51, resets_at: 1787454000 }
  await refreshModelUsage(p, async () => ({ weekly, session: null, modelScoped: entries }))
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

test('ensureFresh は 60 秒より古いキャッシュで更新を起動する', () => {
  const p = tmpFile('cache.json')
  writeJson(p, { _cached_at: nowSec() - 61, _attempted_at: 0, data: [] })
  let spawned = false
  ensureFresh(p, () => {
    spawned = true
  })
  expect(spawned).toBe(true)
})

test('ensureFresh は保持時間の内のキャッシュでは起動しない', () => {
  // 境界の 1 秒手前に置くと 実行が 1 秒ずれただけで結果が変わる
  const p = tmpFile('cache.json')
  writeJson(p, { _cached_at: nowSec() - 1, _attempted_at: 0, data: [] })
  let spawned = false
  ensureFresh(p, () => {
    spawned = true
  })
  expect(spawned).toBe(false)
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

test('ensureFresh は起動前に試行時刻を記録し RETRY_SEC の間は再依頼しない', () => {
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

test('ensureFresh は試行時刻を書き込めなくても例外を投げない', () => {
  // キャッシュのパスがディレクトリだと writeAtomic の rename が失敗する
  const p = tmpFile('cache.json')
  mkdirSync(p)
  let spawned = false
  expect(() =>
    ensureFresh(p, () => {
      spawned = true
    }),
  ).not.toThrow()
  expect(spawned).toBe(false)
})
