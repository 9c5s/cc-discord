import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { archiveStaleThreads, isStaleThread } from '../src/stale-threads'
import { readProgressBody, readTarget, writeProgressBody, writeTarget, type ProgressTarget } from '../src/progress-target'
import type { ApiResult, DiscordClient } from '../src/discord-api'

const testTmpDir = join(tmpdir(), `discord-stale-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`)
let savedStateDir: string | undefined

beforeEach(() => {
  savedStateDir = process.env.DISCORD_STATE_DIR
  process.env.DISCORD_STATE_DIR = join(testTmpDir, 'state')
  mkdirSync(process.env.DISCORD_STATE_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(testTmpDir, { recursive: true, force: true })
  if (savedStateDir === undefined) delete process.env.DISCORD_STATE_DIR
  else process.env.DISCORD_STATE_DIR = savedStateDir
})

const OWNER = 'proj'
const CH = '33333333333333333'
const BOT = '55555555555555555'
const GUILD = '11111111111111111'
const ACT = 'b'.repeat(32)
const OTHER_ACT = 'c'.repeat(32)
const RUN = 'a'.repeat(32)
const SESSION = '57db69e6-bf68-407b-8958-680297cb447f'
const MSG = '99999999999999999'

// Discord epoch から 12 時間より前を指す snowflake を作る
const DISCORD_EPOCH = 1_420_070_400_000
function snowflakeAt(ms: number): string {
  return String((BigInt(ms - DISCORD_EPOCH) << 22n) | 1n)
}

const NOW = 1_800_000_000_000
const OLD = NOW - 13 * 60 * 60 * 1000
const RECENT = NOW - 1 * 60 * 60 * 1000

function thread(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '44444444444444444',
    parent_id: CH,
    owner_id: BOT,
    name: '[08/23 11:00] ping',
    last_message_id: snowflakeAt(OLD),
    thread_metadata: { auto_archive_duration: 60 },
    ...over,
  }
}

// --- isStaleThread ---

const opts = { parentId: CH, botId: BOT, now: NOW }

test('isStaleThread は条件をすべて満たすスレッドを対象にする', () => {
  expect(isStaleThread(thread(), opts)).toBe(true)
})

test('isStaleThread は担当チャンネル以外の子スレッドを除く', () => {
  expect(isStaleThread(thread({ parent_id: '66666666666666666' }), opts)).toBe(false)
})

test('isStaleThread は bot 以外が作ったスレッドを除く', () => {
  expect(isStaleThread(thread({ owner_id: '77777777777777777' }), opts)).toBe(false)
})

test('isStaleThread は名前の規約に合わないスレッドを除く', () => {
  expect(isStaleThread(thread({ name: 'random talk' }), opts)).toBe(false)
})

test('isStaleThread は自動 archive 時間が 60 でないスレッドを除く', () => {
  expect(isStaleThread(thread({ thread_metadata: { auto_archive_duration: 1440 } }), opts)).toBe(false)
})

test('isStaleThread は 12 時間以内に動きのあるスレッドを除く', () => {
  expect(isStaleThread(thread({ last_message_id: snowflakeAt(RECENT) }), opts)).toBe(false)
})

test('isStaleThread は最終メッセージが無ければ作成時刻で判定する', () => {
  const created = new Date(OLD).toISOString()
  expect(isStaleThread(thread({ last_message_id: null, thread_metadata: { auto_archive_duration: 60, create_timestamp: created } }), opts)).toBe(true)
})

test('isStaleThread は時刻を判定できないスレッドを除く', () => {
  expect(isStaleThread(thread({ id: 'x', last_message_id: null, thread_metadata: { auto_archive_duration: 60 } }), opts)).toBe(false)
})

// --- archiveStaleThreads ---

function target(over: Partial<ProgressTarget> = {}): ProgressTarget {
  return {
    id: '44444444444444444',
    parent: CH,
    kind: 'guild',
    session_id: SESSION,
    run_id: RUN,
    activation_id: ACT,
    message_id: MSG,
    written_at: NOW,
    ...over,
  }
}

function fakeApi(threads: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) {
  const archived: string[] = []
  const api = {
    getActiveThreads: async (): Promise<ApiResult<Array<Record<string, unknown>>>> => ({ ok: true, value: threads }),
    archiveThread: async (id: string) => {
      archived.push(id)
      return { ok: true as const, value: null }
    },
    ...over,
  } as unknown as DiscordClient
  return { api, archived }
}

const args = { owner: OWNER, guildId: GUILD, ownerChannelId: CH, botId: BOT, now: NOW }

test('archiveStaleThreads は対象スレッドを archive する', async () => {
  const a = fakeApi([thread(), thread({ id: '44444444444444445', last_message_id: snowflakeAt(RECENT) })])
  expect(await archiveStaleThreads(a.api, args)).toEqual(['44444444444444444'])
  expect(a.archived).toEqual(['44444444444444444'])
})

test('archiveStaleThreads は有効な宛先が残っているスレッドを閉じない', async () => {
  writeTarget(OWNER, target())
  const a = fakeApi([thread()])
  expect(await archiveStaleThreads(a.api, args)).toEqual([])
  expect(a.archived).toEqual([])
  expect(readTarget(OWNER, ACT)).not.toBe(null)
})

test('archiveStaleThreads は対象スレッドを指す失効した宛先だけを消す', async () => {
  writeTarget(OWNER, target({ written_at: NOW - 13 * 60 * 60 * 1000 }))
  writeTarget(OWNER, target({ activation_id: OTHER_ACT, id: '44444444444444449' }))
  const a = fakeApi([thread()])
  await archiveStaleThreads(a.api, args)
  expect(readTarget(OWNER, ACT)).toBe(null)
  expect(readTarget(OWNER, OTHER_ACT)).not.toBe(null)
  expect(a.archived).toEqual(['44444444444444444'])
})

test('archiveStaleThreads は期限切れの宛先も id が一致すれば消す', async () => {
  writeTarget(OWNER, target({ written_at: NOW - 13 * 60 * 60 * 1000 }))
  const a = fakeApi([thread()])
  await archiveStaleThreads(a.api, args)
  expect(readTarget(OWNER, ACT)).toBe(null)
})

test('archiveStaleThreads は本体を内容が一致するときだけ消す', async () => {
  writeProgressBody(OWNER, '44444444444444444')
  const a = fakeApi([thread()])
  await archiveStaleThreads(a.api, args)
  expect(readProgressBody(OWNER)).toBe(null)
})

test('archiveStaleThreads は別スレッドを指す本体を残す', async () => {
  writeProgressBody(OWNER, '44444444444444449')
  writeTarget(OWNER, target({ written_at: NOW - 13 * 60 * 60 * 1000 }))
  const a = fakeApi([thread()])
  await archiveStaleThreads(a.api, args)
  expect(readProgressBody(OWNER)).toBe('44444444444444449')
  expect(readTarget(OWNER, ACT)).toBe(null)
})

test('archiveStaleThreads は取得に失敗したら何もしない', async () => {
  const a = fakeApi([], { getActiveThreads: async () => ({ ok: false as const, error: 'http 403' }) })
  expect(await archiveStaleThreads(a.api, args)).toEqual([])
  expect(a.archived).toEqual([])
})

test('archiveStaleThreads は担当名が不正なら何もしない', async () => {
  const a = fakeApi([thread()])
  expect(await archiveStaleThreads(a.api, { ...args, owner: '../evil' })).toEqual([])
  expect(a.archived).toEqual([])
})

test('archiveStaleThreads は archive に失敗したスレッドを結果に含めない', async () => {
  const a = fakeApi([thread()], { archiveThread: async () => ({ ok: false as const, error: 'http 403' }) })
  expect(await archiveStaleThreads(a.api, args)).toEqual([])
})
