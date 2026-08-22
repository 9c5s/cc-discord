import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ensureFresh,
  fetchModelUsage,
  readAccessToken,
  readModelUsage,
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

// --- fetchModelUsage ---

test('fetchModelUsage は weekly_scoped のモデル別枠だけを射影する', async () => {
  const body = {
    limits: [
      { kind: 'session', percent: 28, resets_at: null, scope: null },
      { kind: 'weekly_all', percent: 51, resets_at: null, scope: null },
      WEEKLY_SCOPED,
    ],
  }
  const got = await withFetch(jsonResponse(body), () => fetchModelUsage('tok'))
  expect(got).toEqual([
    {
      display_name: 'Fable',
      percent: 88,
      resets_at: Date.parse('2026-08-23T02:59:59+00:00') / 1000,
    },
  ])
})

test('fetchModelUsage は scope.model が無い要素を除外する', async () => {
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
  expect(await withFetch(jsonResponse(body), () => fetchModelUsage('tok'))).toEqual([])
})

test('fetchModelUsage は resets_at が文字列でなければ null にする', async () => {
  const body = { limits: [{ ...WEEKLY_SCOPED, resets_at: null }] }
  const got = await withFetch(jsonResponse(body), () => fetchModelUsage('tok'))
  expect(got?.[0].resets_at).toBeNull()
})

test('fetchModelUsage は limits が無ければ空配列を返す', async () => {
  expect(await withFetch(jsonResponse({ five_hour: null }), () => fetchModelUsage('tok'))).toEqual(
    [],
  )
})

test('fetchModelUsage はトークンが無ければ HTTP を発行しない', async () => {
  let called = false
  const spy = (async () => {
    called = true
    return new Response('{}')
  }) as unknown as typeof fetch
  expect(await withFetch(spy, () => fetchModelUsage(null))).toBeNull()
  expect(called).toBe(false)
})

test('fetchModelUsage は HTTP エラーなら null を返す', async () => {
  const err = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
  expect(await withFetch(err, () => fetchModelUsage('tok'))).toBeNull()
})

test('fetchModelUsage は通信例外でも null を返す', async () => {
  const boom = (async () => {
    throw new Error('boom')
  }) as unknown as typeof fetch
  expect(await withFetch(boom, () => fetchModelUsage('tok'))).toBeNull()
})

// --- readModelUsage ---

test('readModelUsage はキャッシュのエントリを返す', () => {
  const p = tmpFile('cache.json')
  writeJson(p, { data: [{ display_name: 'Fable', percent: 88, resets_at: 123 }] })
  expect(readModelUsage(p)).toEqual([{ display_name: 'Fable', percent: 88, resets_at: 123 }])
})

test('readModelUsage はキャッシュが無ければ空配列を返す', () => {
  expect(readModelUsage(tmpFile('absent.json'))).toEqual([])
})

test('readModelUsage は percent が数値でない要素を除外する', () => {
  const p = tmpFile('cache.json')
  writeJson(p, { data: [{ display_name: 'Fable', percent: null }, 'junk'] })
  expect(readModelUsage(p)).toEqual([])
})

// --- refreshModelUsage ---

test('refreshModelUsage は取得結果と時刻を書き込む', async () => {
  const p = tmpFile('cache.json')
  const entries: ModelUsageEntry[] = [{ display_name: 'Fable', percent: 88, resets_at: null }]
  await refreshModelUsage(p, async () => entries)
  const c = readJson(p)
  expect(c.data).toEqual(entries)
  expect(typeof c._cached_at).toBe('number')
  expect(typeof c._attempted_at).toBe('number')
})

test('refreshModelUsage は失敗時に既存データを保持し試行時刻だけ更新する', async () => {
  const p = tmpFile('cache.json')
  const kept = [{ display_name: 'Fable', percent: 88, resets_at: null }]
  writeJson(p, { _cached_at: 100, _attempted_at: 100, data: kept })
  await refreshModelUsage(p, async () => null)
  const c = readJson(p)
  expect(c.data).toEqual(kept)
  expect(c._cached_at).toBe(100)
  expect(c._attempted_at as number).toBeGreaterThan(100)
})

// --- ensureFresh ---

const nowSec = (): number => Date.now() / 1000

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
