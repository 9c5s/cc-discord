import { test, expect, beforeEach, afterEach } from 'bun:test'
import { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { writePointer } from '../src/activation'
import type { ChannelLike } from '../src/discord-entity'
import { createExtension, type AccessView, type DiscordOps, type InboundMessage } from '../src/extension'
import { acquireInboundLock, progressDir, type Timers } from '../src/inbound'
import type { ProcessInfo } from '../src/process-tree'
import type { GuildChannels } from '../src/routing'
import type { ThreadView } from '../src/stale-threads'
import { threadName } from '../src/summarize'

const testTmpDir = join(tmpdir(), `discord-extension-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`)
let savedStateDir: string | undefined
let savedConfigDir: string | undefined

beforeEach(() => {
  savedStateDir = process.env.DISCORD_STATE_DIR
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.DISCORD_STATE_DIR = join(testTmpDir, 'state')
  // 使用量 API の認証情報を読ませず ネットワークへ接続させない
  process.env.CLAUDE_CONFIG_DIR = join(testTmpDir, 'config')
  mkdirSync(process.env.DISCORD_STATE_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(testTmpDir, { recursive: true, force: true })
  if (savedStateDir === undefined) delete process.env.DISCORD_STATE_DIR
  else process.env.DISCORD_STATE_DIR = savedStateDir
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
})

const NOW = 1_800_000_000_000
const HOUR = 60 * 60 * 1000
const GUILD = '11111111111111111'
const OWNER_CH = '22222222222222222'
const OTHER_CH = '33333333333333333'
const PROGRESS_THREAD = '44444444444444444'
const DM_CH = '55555555555555555'
const USER = '66666666666666666'
const BOT = '77777777777777777'
const STALE_THREAD = '12121212121212121'
const ANCHOR_1 = '88888888888888881'
const ANCHOR_2 = '88888888888888882'
const THREAD_1 = '99999999999999991'
const THREAD_2 = '99999999999999992'
const ACTIVATION = 'a'.repeat(32)
const SESSION = '57db69e6-bf68-407b-8958-680297cb447f'
const OWN: ProcessInfo = { pid: 20, ppid: 30, startMs: 1_000, argv: ['claude', '--channels', 'plugin:cc-discord@cc-discord'] }

const snowflakeAt = (at: number): string => String(BigInt(at - 1_420_070_400_000) << 22n)
const anchorOf = (n: number): string => `8888888888888888${n}`
// アンカーから立てたスレッドの id
const threadOf = (anchorId: string): string => anchorId.replace(/8/g, '9')

const ownerChannel: ChannelLike = { id: OWNER_CH, type: 0, parentId: null }
const otherChannel: ChannelLike = { id: OTHER_CH, type: 0, parentId: null }
const progressThread: ChannelLike = { id: PROGRESS_THREAD, type: 11, parentId: OWNER_CH }
const dmChannel: ChannelLike = { id: DM_CH, type: 1, recipientId: USER }
const GUILDS: GuildChannels[] = [
  {
    guildId: GUILD,
    channels: [
      { id: OWNER_CH, name: 'eagle', type: 0 },
      { id: OTHER_CH, name: 'other', type: 0 },
    ],
  },
]

function inbound(channel: ChannelLike, id = snowflakeAt(NOW - 1_000), content = 'hello'): InboundMessage {
  return { id, channelId: channel.id, content, author: { id: USER }, channel }
}

function ownerEnv(name: string): NodeJS.ProcessEnv {
  return { CC_DISCORD_PROJECT_DIR: join(testTmpDir, name) }
}

// OWN が書いた現行 activation のポインタと 中身の無い transcript を用意して transcript のパスを返す
function writeActivation(): string {
  mkdirSync(testTmpDir, { recursive: true })
  const transcript = join(testTmpDir, 'transcript.jsonl')
  writeFileSync(transcript, '')
  writePointer({
    claude_pid: 20,
    claude_started_at: 1_000,
    session_id: SESSION,
    activation_id: ACTIVATION,
    transcript_path: transcript,
    source: 'startup',
    written_at: NOW,
  })
  return transcript
}

function locks(): string[] {
  try {
    return readdirSync(progressDir())
  } catch {
    return []
  }
}

// マイクロタスクで進む処理を終わらせる
const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

// 登録された周期処理を記録し 指定した周期のものを手で動かす
function fakeTimers() {
  let seq = 0
  const intervals = new Map<number, { fn: () => unknown; ms: number }>()
  const timers: Timers = {
    setInterval: (fn, ms) => {
      intervals.set(++seq, { fn, ms })
      return seq
    },
    clearInterval: (h) => {
      intervals.delete(h as number)
    },
    setTimeout: () => ++seq,
    clearTimeout: () => {},
  }
  return {
    timers,
    periods: (): number[] => [...intervals.values()].map((t) => t.ms).sort((a, b) => a - b),
    // 周期処理が返す Promise まで待つ
    async fire(ms: number): Promise<void> {
      for (const t of [...intervals.values()]) if (t.ms === ms) await t.fn()
    },
  }
}

type Options = { env?: NodeJS.ProcessEnv; own?: ProcessInfo | null; ops?: Partial<DiscordOps>; pluginDir?: string }

function setup(opts: Options = {}) {
  const clock = { now: NOW }
  const logs: string[] = []
  const calls: unknown[][] = []
  const access: AccessView = { allowFrom: [USER], groups: { [OWNER_CH]: {}, [OTHER_CH]: {} } }
  const channels = new Map<string, ChannelLike>(
    [ownerChannel, otherChannel, progressThread, dmChannel].map((c) => [c.id, c]),
  )
  let anchors = 0
  const ops: DiscordOps = {
    guilds: () => {
      calls.push(['guilds'])
      return GUILDS
    },
    botId: () => BOT,
    channel: (id) => channels.get(id) ?? null,
    sendTyping: async (chatId) => {
      calls.push(['sendTyping', chatId])
    },
    postAnchor: async (chatId) => {
      calls.push(['postAnchor', chatId])
      return anchorOf(++anchors)
    },
    startThread: async (chatId, anchorId, name) => {
      calls.push(['startThread', chatId, anchorId, name])
      const id = threadOf(anchorId)
      channels.set(id, { id, type: 11, parentId: chatId })
      return id
    },
    postProgress: async (targetId, text) => {
      calls.push(['postProgress', targetId, text])
      return { ok: true }
    },
    listActiveThreads: async (guildId) => {
      calls.push(['listActiveThreads', guildId])
      return []
    },
    archive: async (id) => {
      calls.push(['archive', id])
      return true
    },
    ...opts.ops,
  }
  const timers = fakeTimers()
  const ext = createExtension({
    ops,
    loadAccess: () => access,
    env: opts.env ?? ownerEnv('eagle'),
    own: opts.own === undefined ? OWN : opts.own,
    now: () => clock.now,
    log: (m) => logs.push(m),
    timers: timers.timers,
    ...(opts.pluginDir ? { pluginDir: opts.pluginDir } : {}),
  })
  const named = (name: string): unknown[][] => calls.filter((c) => c[0] === name)
  return { ext, clock, logs, calls, named, access, channels, timers }
}

// transcript に assistant の text を 1 行足し transcript の読み取りの周期を 1 回動かす
async function forward(w: ReturnType<typeof setup>, transcript: string, text: string): Promise<void> {
  appendFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n')
  await w.timers.fire(250)
}

// --- inbound ---

test('channel が無効なら inbound を扱わず ロックも typing も取らない', async () => {
  writeActivation()
  const w = setup({ own: { ...OWN, argv: ['claude'] } })
  expect(await w.ext.admitInbound(inbound(ownerChannel))).toBe(false)
  expect(locks()).toEqual([])
  expect(w.named('sendTyping')).toEqual([])
  expect(w.named('postAnchor')).toEqual([])
})

test('担当チャンネルの inbound はロックを取り スレッドを作って宛先を設定し true を返す', async () => {
  const transcript = writeActivation()
  const w = setup()
  w.ext.start()
  const msg = inbound(ownerChannel, snowflakeAt(NOW - 1_000), 'build it')
  expect(await w.ext.admitInbound(msg)).toBe(true)
  expect(locks()).toEqual([`eagle.lock-${msg.id}`])
  expect(w.named('sendTyping')).toEqual([['sendTyping', OWNER_CH]])
  expect(w.named('postAnchor')).toEqual([['postAnchor', OWNER_CH]])
  expect(w.named('startThread')).toEqual([['startThread', OWNER_CH, ANCHOR_1, threadName('build it', new Date(NOW))]])
  await forward(w, transcript, 'working')
  expect(w.named('postProgress')).toEqual([['postProgress', THREAD_1, '💬 working']])
  // typing は 8 秒ごとに送り直す
  await w.timers.fire(8_000)
  expect(w.named('sendTyping')).toHaveLength(2)
})

test('進捗スレッドの中の inbound はスレッドを作らず そのスレッドを宛先にする', async () => {
  const transcript = writeActivation()
  const w = setup()
  w.ext.start()
  expect(await w.ext.admitInbound(inbound(progressThread))).toBe(true)
  expect(w.named('postAnchor')).toEqual([])
  expect(w.named('startThread')).toEqual([])
  await forward(w, transcript, 'working')
  expect(w.named('postProgress')).toEqual([['postProgress', PROGRESS_THREAD, '💬 working']])
})

test('担当外のチャンネルの inbound は false を返しロックを取らない', async () => {
  writeActivation()
  const w = setup()
  expect(await w.ext.admitInbound(inbound(otherChannel))).toBe(false)
  expect(await w.ext.admitInbound(inbound({ id: STALE_THREAD, type: 11, parentId: OTHER_CH }))).toBe(false)
  expect(locks()).toEqual([])
  expect(w.named('sendTyping')).toEqual([])
  expect(w.named('postAnchor')).toEqual([])
})

test('DM は cc-discord 担当のセッションだけが扱う', async () => {
  const transcript = writeActivation()
  const eagle = setup()
  expect(await eagle.ext.admitInbound(inbound(dmChannel))).toBe(false)
  expect(locks()).toEqual([])

  const dmOwner = setup({ env: ownerEnv('cc-discord') })
  dmOwner.ext.start()
  const msg = inbound(dmChannel)
  expect(await dmOwner.ext.admitInbound(msg)).toBe(true)
  expect(locks()).toEqual([`cc-discord.lock-${msg.id}`])
  expect(dmOwner.named('postAnchor')).toEqual([])
  // DM はその場を宛先にし 相手が allowFrom にある間だけ送る
  await forward(dmOwner, transcript, 'working')
  expect(dmOwner.named('postProgress')).toEqual([['postProgress', DM_CH, '💬 working']])
  dmOwner.access.allowFrom = []
  await forward(dmOwner, transcript, 'after')
  expect(dmOwner.named('postProgress')).toHaveLength(1)
})

test('ロックを他のプロセスが持っていれば false を返す', async () => {
  writeActivation()
  const w = setup()
  const msg = inbound(ownerChannel)
  expect(acquireInboundLock('eagle', msg.id)).toBe(true)
  expect(await w.ext.admitInbound(msg)).toBe(false)
  expect(w.named('sendTyping')).toEqual([])
  expect(w.named('postAnchor')).toEqual([])
})

test('生成から 1 時間を超えた inbound は false を返す', async () => {
  writeActivation()
  const w = setup()
  expect(await w.ext.admitInbound(inbound(ownerChannel, snowflakeAt(NOW - HOUR - 1_000)))).toBe(false)
  expect(locks()).toEqual([])
  expect(w.named('sendTyping')).toEqual([])
})

test('スレッド作成の待ちの間に鮮度が切れたら false を返し typing を止める', async () => {
  const transcript = writeActivation()
  const w = setup({
    ops: {
      postAnchor: async () => {
        w.clock.now += 2 * HOUR
        return ANCHOR_1
      },
    },
  })
  w.ext.start()
  expect(await w.ext.admitInbound(inbound(ownerChannel))).toBe(false)
  expect(w.named('sendTyping')).toHaveLength(1)
  await w.timers.fire(8_000)
  expect(w.named('sendTyping')).toHaveLength(1)
  // 宛先を設定しない
  await forward(w, transcript, 'working')
  expect(w.named('postProgress')).toEqual([])
})

test('現行 activation が無ければスレッドを作らずに true を返す', async () => {
  const w = setup()
  const msg = inbound(ownerChannel)
  expect(await w.ext.admitInbound(msg)).toBe(true)
  expect(locks()).toEqual([`eagle.lock-${msg.id}`])
  expect(w.named('sendTyping')).toEqual([['sendTyping', OWNER_CH]])
  expect(w.named('postAnchor')).toEqual([])
  expect(w.named('startThread')).toEqual([])
})

test('担当名を持たないセッションは判定もロックもせずに typing を始めて true を返す', async () => {
  writeActivation()
  const w = setup({ env: {} })
  expect(await w.ext.admitInbound(inbound(otherChannel))).toBe(true)
  expect(w.named('guilds')).toEqual([])
  expect(locks()).toEqual([])
  expect(w.named('sendTyping')).toEqual([['sendTyping', OTHER_CH]])
  expect(w.named('postAnchor')).toEqual([])
})

test('own が null のセッションは inbound を扱わない', async () => {
  writeActivation()
  const w = setup({ own: null })
  expect(await w.ext.admitInbound(inbound(ownerChannel))).toBe(false)
  expect(locks()).toEqual([])
  expect(w.named('sendTyping')).toEqual([])
})

test('連続した inbound では後から来たものの宛先が残る', async () => {
  const transcript = writeActivation()
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  let anchors = 0
  const w = setup({
    ops: {
      postAnchor: async (chatId) => {
        w.calls.push(['postAnchor', chatId])
        const n = ++anchors
        if (n === 1) await gate
        return anchorOf(n)
      },
    },
  })
  w.ext.start()
  const first = w.ext.admitInbound(inbound(ownerChannel, snowflakeAt(NOW - 2_000), 'first'))
  const second = w.ext.admitInbound(inbound(ownerChannel, snowflakeAt(NOW - 1_000), 'second'))
  await flush()
  // 1 件目が終わるまで 2 件目の処理は始まらない
  expect(w.named('postAnchor')).toHaveLength(1)
  release()
  expect(await first).toBe(true)
  expect(await second).toBe(true)
  expect(w.named('startThread').map((c) => c[2])).toEqual([ANCHOR_1, ANCHOR_2])
  await forward(w, transcript, 'working')
  expect(w.named('postProgress')).toEqual([['postProgress', THREAD_2, '💬 working']])
})

test('inbound の判定で例外が出たら false を返し 後続の inbound は処理する', async () => {
  let failing = true
  const w = setup({
    ops: {
      guilds: () => {
        if (failing) {
          failing = false
          throw new Error('guilds boom')
        }
        return GUILDS
      },
    },
  })
  expect(await w.ext.admitInbound(inbound(ownerChannel, snowflakeAt(NOW - 2_000)))).toBe(false)
  expect(await w.ext.admitInbound(inbound(ownerChannel, snowflakeAt(NOW - 1_000)))).toBe(true)
  expect(w.logs.some((l) => l.includes('guilds boom'))).toBe(true)
})

test('stopTyping は継続中の typing を止める', async () => {
  const w = setup()
  expect(await w.ext.admitInbound(inbound(ownerChannel))).toBe(true)
  w.ext.stopTyping(OWNER_CH)
  await w.timers.fire(8_000)
  expect(w.named('sendTyping')).toHaveLength(1)
})

// --- outbound ---

test('log は拡張のロガーへそのまま書く', () => {
  const w = setup()
  w.ext.log('[discord] postAnchor failed: Error: boom')
  expect(w.logs).toEqual(['[discord] postAnchor failed: Error: boom'])
})

test('owned は担当外のチャンネルで例外を投げ 担当チャンネルとそのスレッドは通す', () => {
  const w = setup()
  expect(w.ext.owned(ownerChannel)).toBe(ownerChannel)
  expect(w.ext.owned(progressThread)).toBe(progressThread)
  expect(() => w.ext.owned(otherChannel)).toThrow(OTHER_CH)
  expect(() => w.ext.owned({ id: STALE_THREAD, type: 11, parentId: OTHER_CH })).toThrow(STALE_THREAD)
  expect(() => w.ext.owned(dmChannel)).toThrow(DM_CH)
})

test('owned は cc-discord 担当のセッションに DM のチャンネルを通す', () => {
  const w = setup({ env: ownerEnv('cc-discord') })
  expect(w.ext.owned(dmChannel)).toBe(dmChannel)
})

test('owned は担当名を持たないセッションでは担当外のチャンネルも DM も通す', () => {
  const w = setup({ env: {} })
  expect(w.ext.owned(otherChannel)).toBe(otherChannel)
  expect(w.ext.owned(dmChannel)).toBe(dmChannel)
})

test('owned は正規化した担当名が空になるセッションでは担当チャンネルも拒む', () => {
  const w = setup({ env: ownerEnv('___') })
  expect(() => w.ext.owned(ownerChannel)).toThrow('ROUTING_BROKEN')
})

// --- 進捗転送 ---

test('進捗の送信は宛先が担当から外れたら送らない', async () => {
  const transcript = writeActivation()
  const w = setup()
  w.ext.start()
  expect(await w.ext.admitInbound(inbound(ownerChannel))).toBe(true)
  await forward(w, transcript, 'before')
  expect(w.named('postProgress')).toEqual([['postProgress', THREAD_1, '💬 before']])
  delete w.access.groups[OWNER_CH]
  await forward(w, transcript, 'after')
  expect(w.named('postProgress')).toEqual([['postProgress', THREAD_1, '💬 before']])
})

test('宛先の確認で例外が出たら送らずにログに残し 次の転送は続ける', async () => {
  const transcript = writeActivation()
  let broken = false
  const w = setup({
    ops: {
      channel: (id) => {
        if (broken) throw new Error('cache boom')
        return w.channels.get(id) ?? null
      },
    },
  })
  w.ext.start()
  expect(await w.ext.admitInbound(inbound(ownerChannel))).toBe(true)
  broken = true
  await forward(w, transcript, 'lost')
  expect(w.named('postProgress')).toEqual([])
  // 例外は送信の可否の確認の中で捕捉し 転送の周期の失敗にはしない
  expect(w.logs.filter((l) => l.includes('cache boom'))).toEqual([
    '[progress] checking the target failed: Error: cache boom',
  ])
  broken = false
  await forward(w, transcript, 'next')
  expect(w.named('postProgress')).toEqual([['postProgress', THREAD_1, '💬 next']])
})

// --- 周期処理 ---

test('start は channel の判定結果と根拠をログに 1 行出す', () => {
  const enabled = setup()
  enabled.ext.start()
  const enabledLines = enabled.logs.filter((l) => l.startsWith('[channel]'))
  expect(enabledLines).toHaveLength(1)
  expect(enabledLines[0]).toContain('enabled')
  expect(enabledLines[0]).toContain('PID 20')
  expect(enabledLines[0]).toContain('plugin:cc-discord@cc-discord')

  const disabled = setup({ own: null })
  disabled.ext.start()
  const disabledLines = disabled.logs.filter((l) => l.startsWith('[channel]'))
  expect(disabledLines).toHaveLength(1)
  expect(disabledLines[0]).toContain('disabled')
  expect(disabledLines[0]).toContain('CC_DISCORD_CHANNEL=on')
})

test('start は進捗の転送とロックの回収と滞留スレッドの archive の周期を始め stop で止める', async () => {
  const w = setup()
  w.ext.start()
  expect(w.timers.periods()).toEqual([250, 1_000, 60_000, 5 * 60_000])
  expect(await w.ext.admitInbound(inbound(ownerChannel))).toBe(true)
  expect(w.timers.periods()).toContain(8_000)
  w.ext.stop()
  expect(w.timers.periods()).toEqual([])
})

test('ロックの回収は 60 秒ごとに 12 時間より古い担当のロックを消す', async () => {
  const w = setup()
  w.ext.start()
  const msg = inbound(ownerChannel)
  expect(await w.ext.admitInbound(msg)).toBe(true)
  // ロックの経過時間はファイルの mtime (実時間) から測る
  w.clock.now = Date.now()
  await w.timers.fire(60_000)
  expect(locks()).toEqual([`eagle.lock-${msg.id}`])
  w.clock.now = Date.now() + 13 * HOUR
  await w.timers.fire(60_000)
  expect(locks()).toEqual([])
})

test('滞留スレッドの archive は start の直後と 5 分ごとに行い 現在の宛先は閉じない', async () => {
  writeActivation()
  const stale = (id: string): ThreadView => ({
    id,
    parentId: OWNER_CH,
    ownerId: BOT,
    name: '[01/01 00:00] old',
    autoArchiveDuration: 60,
    lastMessageId: snowflakeAt(NOW - 14 * HOUR),
    createdTimestamp: null,
  })
  const w = setup({
    ops: {
      listActiveThreads: async (guildId) => {
        w.calls.push(['listActiveThreads', guildId])
        return [stale(STALE_THREAD), stale(THREAD_1)]
      },
    },
  })
  expect(await w.ext.admitInbound(inbound(ownerChannel))).toBe(true)
  w.ext.start()
  await flush()
  expect(w.named('listActiveThreads')).toEqual([['listActiveThreads', GUILD]])
  expect(w.named('archive')).toEqual([['archive', STALE_THREAD]])
  await w.timers.fire(5 * 60_000)
  expect(w.named('archive')).toEqual([
    ['archive', STALE_THREAD],
    ['archive', STALE_THREAD],
  ])
})

test('滞留スレッドの一覧の取得を待つ間に inbound でそのスレッドが宛先になったら 閉じない', async () => {
  writeActivation()
  const stale = (id: string): ThreadView => ({
    id,
    parentId: OWNER_CH,
    ownerId: BOT,
    name: '[01/01 00:00] old',
    autoArchiveDuration: 60,
    lastMessageId: snowflakeAt(NOW - 14 * HOUR),
    createdTimestamp: null,
  })
  let resolveList!: (threads: ThreadView[]) => void
  const w = setup({
    ops: { listActiveThreads: () => new Promise<ThreadView[]>((r) => (resolveList = r)) },
  })
  w.ext.start()
  expect(await w.ext.admitInbound(inbound(progressThread))).toBe(true)
  resolveList([stale(STALE_THREAD), stale(PROGRESS_THREAD)])
  await flush()
  expect(w.named('archive')).toEqual([['archive', STALE_THREAD]])
})

test('滞留スレッドの archive は前の回が終わるまで次の回を始めない', async () => {
  let resolveList!: (threads: ThreadView[]) => void
  let lists = 0
  const w = setup({
    ops: {
      listActiveThreads: (): Promise<ThreadView[]> => {
        lists++
        return lists === 1 ? new Promise((r) => (resolveList = r)) : Promise.resolve([])
      },
    },
  })
  w.ext.start()
  await w.timers.fire(5 * 60_000)
  expect(lists).toBe(1)
  resolveList([])
  await flush()
  await w.timers.fire(5 * 60_000)
  expect(lists).toBe(2)
})

test('周期処理は例外を投げても止まらずログに残す', async () => {
  let n = 0
  const w = setup({
    ops: {
      listActiveThreads: (): Promise<ThreadView[]> => {
        n++
        if (n === 1) throw new Error('sync boom')
        if (n === 2) return Promise.reject(new Error('async boom'))
        return Promise.resolve([])
      },
    },
  })
  w.ext.start()
  await flush()
  await w.timers.fire(5 * 60_000)
  await w.timers.fire(5 * 60_000)
  expect(n).toBe(3)
  expect(w.logs.filter((l) => l.includes('boom'))).toHaveLength(2)
})

// --- footer ---

test('footer は採用したポインタの transcript のモデルと 上流の印を出す', async () => {
  const transcript = writeActivation()
  appendFileSync(
    transcript,
    JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-opus-5-5', usage: { input_tokens: 10_000 }, content: [] },
    }) + '\n',
  )
  const pluginDir = join(testTmpDir, 'plugin')
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, 'upstream.json'), JSON.stringify({ server_sha256: '0'.repeat(64) }))
  const configDir = join(testTmpDir, 'config')
  const cloneDir = join(configDir, 'plugins', 'marketplaces', 'claude-plugins-official', 'external_plugins', 'discord')
  mkdirSync(join(cloneDir, '.claude-plugin'), { recursive: true })
  writeFileSync(join(cloneDir, 'server.ts'), 'newer')
  writeFileSync(join(cloneDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '0.0.6' }))

  const w = setup({
    env: { ...ownerEnv('eagle'), CC_DISCORD_UPSTREAM_CHECK: '1', CLAUDE_CONFIG_DIR: configDir },
    pluginDir,
  })
  const footer = await w.ext.footer()
  expect(footer).toContain('👾 Opus 5.5')
  expect(footer).toContain('⬆️ upstream 0.0.6')
})

test('footer は組み立てで例外が出たらログに残して空文字を返す', async () => {
  const env = ownerEnv('eagle')
  // 上流のクローンの場所を引く時点で例外を投げる
  Object.defineProperty(env, 'CLAUDE_CONFIG_DIR', {
    enumerable: true,
    get() {
      throw new Error('footer boom')
    },
  })
  const w = setup({ env, pluginDir: join(testTmpDir, 'plugin') })
  expect(await w.ext.footer()).toBe('')
  expect(w.logs.filter((l) => l.includes('footer boom'))).toEqual([
    '[footer] building the footer failed: Error: footer boom',
  ])
})
