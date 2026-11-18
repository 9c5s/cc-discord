import { test, expect } from 'bun:test'
import { Collection, RateLimitError, Routes, type Client } from 'discord.js'
import { createDiscordOps, createProgressRest, type ProgressRest } from '../src/discord-ops'

const GUILD = '11111111111111111'
const OWNER_CH = '22222222222222222'
const CATEGORY = '33333333333333333'
const THREAD = '44444444444444444'
const ANCHOR = '55555555555555555'
const BOT = '66666666666666666'
const LAST_MESSAGE = '77777777777777777'

// REST を使わない操作のテストで渡す (呼ばれたら失敗させる)
const noRest: ProgressRest = {
  post: async () => {
    throw new Error('unexpected REST call')
  },
}

// 操作が触る部分だけを持つ discord.js の Client の偽物
function fakeClient(
  parts: {
    user?: { id: string } | null
    guilds?: Collection<string, unknown>
    cache?: Collection<string, unknown>
    // client.channels.fetch が返すチャンネル
    fetched?: Record<string, unknown>
  } = {},
): Client {
  return {
    user: parts.user ?? null,
    guilds: { cache: parts.guilds ?? new Collection() },
    channels: {
      cache: parts.cache ?? new Collection(),
      fetch: async (id: string) => {
        const ch = parts.fetched?.[id]
        if (!ch) throw new Error(`Unknown Channel ${id}`)
        return ch
      },
    },
  } as unknown as Client
}

function rateLimitError(retryAfter: number): RateLimitError {
  return new RateLimitError({
    timeToReset: retryAfter,
    limit: 5,
    method: 'POST',
    hash: 'hash',
    url: `https://discord.com/api/v10/channels/${THREAD}/messages`,
    route: '/channels/:id/messages',
    majorParameter: THREAD,
    global: false,
    retryAfter,
    sublimitTimeout: 0,
    scope: 'user',
  })
}

// 偽の Discord API を立て 受けた POST を数える
function fakeApi(respond: () => Response) {
  const posts: { path: string; authorization: string | null; body: unknown }[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      if (req.method === 'POST') {
        posts.push({
          path: new URL(req.url).pathname,
          authorization: req.headers.get('authorization'),
          body: await req.json(),
        })
      }
      return respond()
    },
  })
  return { posts, api: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

// --- Gateway のキャッシュ ---

test('guilds は Collection の values から担当の決定関数が受け取る形に組み立てる', () => {
  const channels = new Collection<string, unknown>([
    [OWNER_CH, { id: OWNER_CH, name: 'eagle', type: 0, parentId: CATEGORY }],
    [THREAD, { id: THREAD, name: '[01/01 00:00] old', type: 11, parentId: OWNER_CH }],
  ])
  const client = fakeClient({
    guilds: new Collection<string, unknown>([[GUILD, { id: GUILD, channels: { cache: channels } }]]),
  })
  expect(createDiscordOps(client, noRest).guilds()).toEqual([
    {
      guildId: GUILD,
      channels: [
        { id: OWNER_CH, name: 'eagle', type: 0 },
        { id: THREAD, name: '[01/01 00:00] old', type: 11 },
      ],
    },
  ])
})

test('botId は client.user の id を返し ログイン前は null を返す', () => {
  expect(createDiscordOps(fakeClient({ user: { id: BOT } }), noRest).botId()).toBe(BOT)
  expect(createDiscordOps(fakeClient({ user: null }), noRest).botId()).toBeNull()
})

test('channel は client.channels.cache から引き 無ければ null を返す', () => {
  const thread = { id: THREAD, type: 11, parentId: OWNER_CH }
  const ops = createDiscordOps(fakeClient({ cache: new Collection<string, unknown>([[THREAD, thread]]) }), noRest)
  expect(ops.channel(THREAD)).toBe(thread)
  expect(ops.channel(OWNER_CH)).toBeNull()
})

// --- 送信 ---

test('sendTyping はチャンネルの sendTyping を呼び 失敗しても例外を外へ出さない', async () => {
  const typed: string[] = []
  const ops = createDiscordOps(
    fakeClient({
      fetched: {
        [OWNER_CH]: {
          sendTyping: async () => {
            typed.push(OWNER_CH)
          },
        },
        [THREAD]: {
          sendTyping: async () => {
            throw new Error('typing boom')
          },
        },
      },
    }),
    noRest,
  )
  await ops.sendTyping(OWNER_CH)
  expect(typed).toEqual([OWNER_CH])
  await expect(ops.sendTyping(THREAD)).resolves.toBeUndefined()
  await expect(ops.sendTyping(CATEGORY)).resolves.toBeUndefined()
})

test('postAnchor は U+200B を通知抑止の flags と allowedMentions parse [] で送り id を返す', async () => {
  const sent: unknown[] = []
  const ops = createDiscordOps(
    fakeClient({
      fetched: {
        [OWNER_CH]: {
          send: async (options: unknown) => {
            sent.push(options)
            return { id: ANCHOR }
          },
        },
      },
    }),
    noRest,
  )
  expect(await ops.postAnchor(OWNER_CH)).toBe(ANCHOR)
  expect(sent).toEqual([{ content: '\u200b', flags: 4096, allowedMentions: { parse: [] } }])
})

test('postAnchor は送信が例外を投げたら null を返す', async () => {
  const ops = createDiscordOps(
    fakeClient({
      fetched: {
        [OWNER_CH]: {
          send: async () => {
            throw new Error('send boom')
          },
        },
      },
    }),
    noRest,
  )
  expect(await ops.postAnchor(OWNER_CH)).toBeNull()
  // チャンネルを取得できない場合も null にする
  expect(await ops.postAnchor(CATEGORY)).toBeNull()
})

test('startThread は自動 archive 60 分でスレッドを立て id を返す', async () => {
  const fetchedMessages: string[] = []
  const started: unknown[] = []
  const ops = createDiscordOps(
    fakeClient({
      fetched: {
        [OWNER_CH]: {
          messages: {
            fetch: async (id: string) => {
              fetchedMessages.push(id)
              return {
                id,
                startThread: async (options: unknown) => {
                  started.push(options)
                  return { id: THREAD }
                },
              }
            },
          },
        },
      },
    }),
    noRest,
  )
  expect(await ops.startThread(OWNER_CH, ANCHOR, '[01/01 00:00] build it')).toBe(THREAD)
  expect(fetchedMessages).toEqual([ANCHOR])
  expect(started).toEqual([{ name: '[01/01 00:00] build it', autoArchiveDuration: 60 }])
})

test('startThread はスレッドの作成が例外を投げたら null を返す', async () => {
  const ops = createDiscordOps(
    fakeClient({
      fetched: {
        [OWNER_CH]: {
          messages: {
            fetch: async (id: string) => ({
              id,
              startThread: async () => {
                throw new Error('thread boom')
              },
            }),
          },
        },
      },
    }),
    noRest,
  )
  expect(await ops.startThread(OWNER_CH, ANCHOR, '[01/01 00:00] build it')).toBeNull()
})

// --- 進捗の投稿 ---

test('postProgress は Routes.channelMessages へ flags 4096 と allowedMentions parse [] で送り ok を返す', async () => {
  const posted: unknown[][] = []
  const rest: ProgressRest = {
    post: async (route, options) => {
      posted.push([route, options])
      return { id: LAST_MESSAGE }
    },
  }
  const ops = createDiscordOps(fakeClient(), rest)
  expect(await ops.postProgress(THREAD, 'progress text')).toEqual({ ok: true })
  expect(posted).toEqual([
    [`/channels/${THREAD}/messages`, { body: { content: 'progress text', flags: 4096, allowed_mentions: { parse: [] } } }],
  ])
})

test('postProgress は RateLimitError を retryAfterMs 付きの失敗にする', async () => {
  const rest: ProgressRest = {
    post: async () => {
      throw rateLimitError(3000)
    },
  }
  expect(await createDiscordOps(fakeClient(), rest).postProgress(THREAD, 'x')).toStrictEqual({
    ok: false,
    retryAfterMs: 3000,
  })
})

test('postProgress はそれ以外の例外を retryAfterMs 無しの失敗にする', async () => {
  const rest: ProgressRest = {
    post: async () => {
      throw new Error('500 Internal Server Error')
    },
  }
  expect(await createDiscordOps(fakeClient(), rest).postProgress(THREAD, 'x')).toStrictEqual({ ok: false })
})

// --- 滞留スレッド ---

test('listActiveThreads は fetchActiveThreads の結果を ThreadView に変換する', async () => {
  const created = 1_800_000_000_000
  const threads = new Collection<string, unknown>([
    [
      THREAD,
      {
        id: THREAD,
        parentId: OWNER_CH,
        ownerId: BOT,
        name: '[01/01 00:00] old',
        autoArchiveDuration: 60,
        lastMessageId: LAST_MESSAGE,
        createdTimestamp: created,
        archived: false,
      },
    ],
    [ANCHOR, { id: ANCHOR, parentId: null, ownerId: null, name: 'bare', autoArchiveDuration: null, lastMessageId: null, createdTimestamp: null }],
  ])
  const guild = { id: GUILD, channels: { fetchActiveThreads: async () => ({ threads, members: new Collection() }) } }
  const ops = createDiscordOps(fakeClient({ guilds: new Collection<string, unknown>([[GUILD, guild]]) }), noRest)
  expect(await ops.listActiveThreads(GUILD)).toEqual([
    {
      id: THREAD,
      parentId: OWNER_CH,
      ownerId: BOT,
      name: '[01/01 00:00] old',
      autoArchiveDuration: 60,
      lastMessageId: LAST_MESSAGE,
      createdTimestamp: created,
    },
    { id: ANCHOR, parentId: null, ownerId: null, name: 'bare', autoArchiveDuration: null, lastMessageId: null, createdTimestamp: null },
  ])
})

test('listActiveThreads は取得が例外を投げたら空の配列を返す', async () => {
  const guild = {
    id: GUILD,
    channels: {
      fetchActiveThreads: async () => {
        throw new Error('fetch boom')
      },
    },
  }
  const ops = createDiscordOps(fakeClient({ guilds: new Collection<string, unknown>([[GUILD, guild]]) }), noRest)
  expect(await ops.listActiveThreads(GUILD)).toEqual([])
  // キャッシュに無い guild も空にする
  expect(await ops.listActiveThreads(CATEGORY)).toEqual([])
})

test('archive は setArchived(true) を呼んで true を返す', async () => {
  const calls: unknown[] = []
  const thread = {
    isThread: () => true,
    setArchived: async (archived: unknown) => {
      calls.push(archived)
    },
  }
  expect(await createDiscordOps(fakeClient({ fetched: { [THREAD]: thread } }), noRest).archive(THREAD)).toBe(true)
  expect(calls).toEqual([true])
})

test('archive は setArchived が例外を投げたら false を返す', async () => {
  const thread = {
    isThread: () => true,
    setArchived: async () => {
      throw new Error('archive boom')
    },
  }
  expect(await createDiscordOps(fakeClient({ fetched: { [THREAD]: thread } }), noRest).archive(THREAD)).toBe(false)
})

// --- 進捗用の REST クライアント ---

test('createProgressRest は api の送り先へトークン付きで POST する', async () => {
  const api = fakeApi(() => Response.json({ id: LAST_MESSAGE }))
  try {
    const rest = createProgressRest('test-token', { api: api.api })
    expect(await rest.post(Routes.channelMessages(THREAD), { body: { content: 'x' } })).toEqual({ id: LAST_MESSAGE })
    expect(api.posts).toEqual([
      { path: `/v10/channels/${THREAD}/messages`, authorization: 'Bot test-token', body: { content: 'x' } },
    ])
  } finally {
    api.stop()
  }
})

test('createProgressRest は 500 の応答を自動で送り直さない', async () => {
  const api = fakeApi(() => new Response('{}', { status: 500 }))
  try {
    const rest = createProgressRest('test-token', { api: api.api })
    await expect(rest.post(Routes.channelMessages(THREAD), { body: { content: 'x' } })).rejects.toThrow()
    expect(api.posts).toHaveLength(1)
  } finally {
    api.stop()
  }
})

test('createProgressRest は 429 の応答で待たずに RateLimitError を投げる', async () => {
  const api = fakeApi(() =>
    Response.json(
      { message: 'You are being rate limited.', retry_after: 3, global: false },
      { status: 429, headers: { 'Retry-After': '3' } },
    ),
  )
  try {
    const rest = createProgressRest('test-token', { api: api.api })
    const started = performance.now()
    const err = await rest.post(Routes.channelMessages(THREAD), { body: { content: 'x' } }).then(
      () => null,
      (e: unknown) => e,
    )
    // 待っていれば Retry-After の 3 秒を超える
    expect(performance.now() - started).toBeLessThan(3_000)
    expect(err).toBeInstanceOf(RateLimitError)
    // 秒数 x 1000 に既定の offset 50 ms を足した値
    expect((err as RateLimitError).retryAfter).toBe(3050)
    expect(api.posts).toHaveLength(1)
  } finally {
    api.stop()
  }
})
