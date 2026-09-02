import { test, expect } from 'bun:test'
import { createDiscordClient } from '../src/discord-api'

const CH = '33333333333333333'
const MSG = '99999999999999999'
const GUILD = '11111111111111111'

type Call = { url: string; init: RequestInit }

// 応答を順に返す fetch を作り 呼び出しを記録する
function fakeFetch(bodies: Array<{ status?: number; json?: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = []
  let i = 0
  const fn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} })
    const spec = bodies[Math.min(i, bodies.length - 1)]
    i++
    return new Response(spec.json === undefined ? '' : JSON.stringify(spec.json), {
      status: spec.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...(spec.headers ?? {}) },
    })
  }
  return { fn: fn as unknown as typeof fetch, calls }
}

function client(bodies: Parameters<typeof fakeFetch>[0], over: Record<string, unknown> = {}) {
  const f = fakeFetch(bodies)
  const api = createDiscordClient({ token: 'tok', fetchFn: f.fn, sleep: async () => {}, ...over })
  return { api, calls: f.calls }
}

// --- 認証と URL ---

test('getChannel は Bot トークンを付けて GET する', async () => {
  const { api, calls } = client([{ json: { id: CH, type: 0 } }])
  const res = await api.getChannel(CH)
  expect(res).toEqual({ ok: true, value: { id: CH, type: 0 } })
  expect(calls[0].url).toBe(`https://discord.com/api/v10/channels/${CH}`)
  expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bot tok')
})

test('トークンが無ければ HTTP を発行せず失敗を返す', async () => {
  const { api, calls } = client([{ json: {} }], { token: null })
  expect(await api.getChannel(CH)).toEqual({ ok: false, error: 'no bot token' })
  expect(calls).toHaveLength(0)
})

test('snowflake でない id では HTTP を発行しない', async () => {
  const { api, calls } = client([{ json: {} }])
  expect(await api.getChannel('../evil')).toEqual({ ok: false, error: 'invalid id: ../evil' })
  expect(calls).toHaveLength(0)
})

test('HTTP エラーは状態コードを含む失敗を返す', async () => {
  const { api } = client([{ status: 403, json: { message: 'Missing Access' } }])
  const res = await api.getChannel(CH)
  expect(res.ok).toBe(false)
  expect(res.ok === false && res.error).toContain('403')
})

// --- 429 の再送 ---

test('429 は retry_after を待って 1 回だけ再送する', async () => {
  const waits: number[] = []
  const { api, calls } = client(
    [{ status: 429, json: { retry_after: 1.5 } }, { json: { id: CH, type: 0 } }],
    { sleep: async (ms: number) => void waits.push(ms) },
  )
  expect(await api.getChannel(CH)).toEqual({ ok: true, value: { id: CH, type: 0 } })
  expect(calls).toHaveLength(2)
  expect(waits).toEqual([1500])
})

test('429 の待機は 5 秒を上限にする', async () => {
  const waits: number[] = []
  const { api } = client(
    [{ status: 429, json: { retry_after: 30 } }, { json: { id: CH } }],
    { sleep: async (ms: number) => void waits.push(ms) },
  )
  await api.getChannel(CH)
  expect(waits).toEqual([5000])
})

test('autoRetry を切ると 429 で再送せず待ち時間を返す', async () => {
  const { api, calls } = client([{ status: 429, json: { retry_after: 2 } }])
  const res = await api.createMessage(CH, { content: 'x' }, undefined, { autoRetry: false })
  expect(res.ok).toBe(false)
  expect(res.ok === false && res.retryAfterMs).toBe(2000)
  expect(calls).toHaveLength(1)
})

test('再送も 429 なら失敗を返す', async () => {
  const { api, calls } = client([{ status: 429, json: { retry_after: 0.1 } }])
  const res = await api.getChannel(CH)
  expect(res.ok).toBe(false)
  expect(calls).toHaveLength(2)
})

// --- キャッシュ ---

test('getChannel は同じ id を TTL 内で再取得しない', async () => {
  const { api, calls } = client([{ json: { id: CH, type: 0 } }])
  await api.getChannel(CH)
  await api.getChannel(CH)
  expect(calls).toHaveLength(1)
})

test('getChannel は TTL を過ぎたら再取得する', async () => {
  let now = 1_000_000
  const { api, calls } = client([{ json: { id: CH, type: 0 } }], { now: () => now })
  await api.getChannel(CH)
  now += 60_001
  await api.getChannel(CH)
  expect(calls).toHaveLength(2)
})

test('失敗した取得はキャッシュしない', async () => {
  const { api, calls } = client([{ status: 500, json: {} }, { json: { id: CH } }])
  expect((await api.getChannel(CH)).ok).toBe(false)
  expect((await api.getChannel(CH)).ok).toBe(true)
  expect(calls).toHaveLength(2)
})

test('getGuilds と getGuildChannels もキャッシュする', async () => {
  const { api, calls } = client([{ json: [{ id: GUILD }] }])
  await api.getGuilds()
  await api.getGuilds()
  expect(calls).toHaveLength(1)
  await api.getGuildChannels(GUILD)
  await api.getGuildChannels(GUILD)
  expect(calls).toHaveLength(2)
  expect(calls[1].url).toBe(`https://discord.com/api/v10/guilds/${GUILD}/channels`)
})

// --- 送信系 ---

test('sendTyping は typing エンドポイントへ POST する', async () => {
  const { api, calls } = client([{ status: 204 }])
  expect((await api.sendTyping(CH)).ok).toBe(true)
  expect(calls[0].url).toBe(`https://discord.com/api/v10/channels/${CH}/typing`)
  expect(calls[0].init.method).toBe('POST')
})

test('createMessage は JSON ボディを送り 応答の id を返す', async () => {
  const { api, calls } = client([{ json: { id: MSG } }])
  const res = await api.createMessage(CH, { content: 'hi', allowed_mentions: { parse: [] } })
  expect(res).toEqual({ ok: true, value: { id: MSG } })
  expect(calls[0].init.method).toBe('POST')
  expect(JSON.parse(calls[0].init.body as string)).toEqual({ content: 'hi', allowed_mentions: { parse: [] } })
})

test('createMessage は添付があれば multipart で送る', async () => {
  const { api, calls } = client([{ json: { id: MSG } }])
  const file = { name: 'a.txt', data: new Uint8Array([104, 105]), type: 'text/plain' }
  await api.createMessage(CH, { content: 'hi' }, [file])
  const body = calls[0].init.body as FormData
  expect(body).toBeInstanceOf(FormData)
  expect(JSON.parse(body.get('payload_json') as string)).toEqual({ content: 'hi' })
  expect((body.get('files[0]') as File).name).toBe('a.txt')
})

test('createMessage は multipart のとき Content-Type を自分で設定しない', async () => {
  const { api, calls } = client([{ json: { id: MSG } }])
  await api.createMessage(CH, { content: 'hi' }, [{ name: 'a.txt', data: new Uint8Array([1]), type: 'text/plain' }])
  expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBeUndefined()
})

test('editMessage は PATCH する', async () => {
  const { api, calls } = client([{ json: { id: MSG } }])
  expect((await api.editMessage(CH, MSG, { content: 'x' })).ok).toBe(true)
  expect(calls[0].url).toBe(`https://discord.com/api/v10/channels/${CH}/messages/${MSG}`)
  expect(calls[0].init.method).toBe('PATCH')
})

test('startThread はアンカーに紐づくスレッドを作る', async () => {
  const { api, calls } = client([{ json: { id: '44444444444444444' } }])
  const res = await api.startThread(CH, MSG, { name: '[08/23 11:00] x', auto_archive_duration: 60 })
  expect(res).toEqual({ ok: true, value: { id: '44444444444444444' } })
  expect(calls[0].url).toBe(`https://discord.com/api/v10/channels/${CH}/messages/${MSG}/threads`)
})

test('archiveThread はスレッドを archived にする', async () => {
  const { api, calls } = client([{ json: { id: '44444444444444444' } }])
  expect((await api.archiveThread('44444444444444444')).ok).toBe(true)
  expect(calls[0].init.method).toBe('PATCH')
  expect(JSON.parse(calls[0].init.body as string)).toEqual({ archived: true })
})

test('getActiveThreads は guild の稼働中スレッドを返す', async () => {
  const { api, calls } = client([{ json: { threads: [{ id: '44444444444444444' }] } }])
  const res = await api.getActiveThreads(GUILD)
  expect(res).toEqual({ ok: true, value: [{ id: '44444444444444444' }] })
  expect(calls[0].url).toBe(`https://discord.com/api/v10/guilds/${GUILD}/threads/active`)
})

test('getCurrentUser は bot 自身を返す', async () => {
  const { api, calls } = client([{ json: { id: '55555555555555555' } }])
  expect(await api.getCurrentUser()).toEqual({ ok: true, value: { id: '55555555555555555' } })
  expect(calls[0].url).toBe('https://discord.com/api/v10/users/@me')
})

// --- 例外 ---

test('通信例外は失敗として扱う', async () => {
  const api = createDiscordClient({
    token: 'tok',
    fetchFn: (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch,
    sleep: async () => {},
  })
  const res = await api.getChannel(CH)
  expect(res.ok).toBe(false)
  expect(res.ok === false && res.error).toContain('network down')
})
