import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync, existsSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { acquireInboundLock, createProgressTarget, createTypingController, sweepInboundLocks } from '../src/inbound'
import { progressDir } from '../src/progress-target'
import type { ApiResult, DiscordClient } from '../src/discord-api'

const testTmpDir = join(tmpdir(), `discord-inbound-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`)
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
const MSG = '99999999999999999'
const THREAD = '44444444444444444'
const ANCHOR = '88888888888888888'

// --- acquireInboundLock ---

test('acquireInboundLock は最初の 1 回だけ成功する', () => {
  expect(acquireInboundLock(OWNER, MSG)).toBe(true)
  expect(acquireInboundLock(OWNER, MSG)).toBe(false)
})

test('acquireInboundLock は message_id ごとに別のロックを取る', () => {
  expect(acquireInboundLock(OWNER, MSG)).toBe(true)
  expect(acquireInboundLock(OWNER, '99999999999999998')).toBe(true)
})

test('acquireInboundLock は不正な担当名や message_id では取らない', () => {
  expect(acquireInboundLock('../evil', MSG)).toBe(false)
  expect(acquireInboundLock(OWNER, '../evil')).toBe(false)
})

// --- sweepInboundLocks ---

test('sweepInboundLocks は 12 時間より古いロックを消す', () => {
  acquireInboundLock(OWNER, MSG)
  const f = join(progressDir(), `${OWNER}.lock-${MSG}`)
  const old = new Date(Date.now() - 13 * 60 * 60 * 1000)
  utimesSync(f, old, old)
  expect(sweepInboundLocks(OWNER)).toBe(1)
  expect(existsSync(f)).toBe(false)
})

test('sweepInboundLocks は処理が長引いた分のロックを残す', () => {
  acquireInboundLock(OWNER, MSG)
  const f = join(progressDir(), `${OWNER}.lock-${MSG}`)
  const old = new Date(Date.now() - 5 * 60 * 1000)
  utimesSync(f, old, old)
  expect(sweepInboundLocks(OWNER)).toBe(0)
  expect(existsSync(f)).toBe(true)
})

test('sweepInboundLocks は新しいロックを残す', () => {
  acquireInboundLock(OWNER, MSG)
  expect(sweepInboundLocks(OWNER)).toBe(0)
  expect(existsSync(join(progressDir(), `${OWNER}.lock-${MSG}`))).toBe(true)
})

test('sweepInboundLocks は他の担当のロックを消さない', () => {
  acquireInboundLock('other', MSG)
  const f = join(progressDir(), `other.lock-${MSG}`)
  const old = new Date(Date.now() - 13 * 60 * 60 * 1000)
  utimesSync(f, old, old)
  expect(sweepInboundLocks(OWNER)).toBe(0)
  expect(existsSync(f)).toBe(true)
})

test('sweepInboundLocks は宛先ファイルを消さない', () => {
  mkdirSync(progressDir(), { recursive: true })
  const f = join(progressDir(), `${OWNER}.${'b'.repeat(32)}.meta`)
  writeFileSync(f, '{}')
  const old = new Date(Date.now() - 61_000)
  utimesSync(f, old, old)
  expect(sweepInboundLocks(OWNER)).toBe(0)
  expect(existsSync(f)).toBe(true)
})

// --- createTypingController ---

type Timer = { fn: () => void; ms: number; cleared: boolean }

function fakeTimers() {
  const intervals: Timer[] = []
  const timeouts: Timer[] = []
  return {
    intervals,
    timeouts,
    timers: {
      setInterval: (fn: () => void, ms: number) => {
        intervals.push({ fn, ms, cleared: false })
        return intervals.length - 1
      },
      clearInterval: (h: unknown) => {
        intervals[h as number].cleared = true
      },
      setTimeout: (fn: () => void, ms: number) => {
        timeouts.push({ fn, ms, cleared: false })
        return timeouts.length - 1
      },
      clearTimeout: (h: unknown) => {
        timeouts[h as number].cleared = true
      },
    },
  }
}

function typingApi() {
  const sent: string[] = []
  const api = {
    sendTyping: async (id: string): Promise<ApiResult<null>> => {
      sent.push(id)
      return { ok: true, value: null }
    },
  } as unknown as DiscordClient
  return { api, sent }
}

test('createTypingController は開始時に typing を送り 再送タイマーを張る', async () => {
  const t = typingApi()
  const f = fakeTimers()
  const c = createTypingController(t.api, { timers: f.timers })
  c.start(CH)
  await Promise.resolve()
  expect(t.sent).toEqual([CH])
  expect(f.intervals[0].ms).toBe(8_000)
  expect(f.timeouts[0].ms).toBe(600_000)
})

test('createTypingController は再送タイマーで typing を送り直す', async () => {
  const t = typingApi()
  const f = fakeTimers()
  createTypingController(t.api, { timers: f.timers }).start(CH)
  f.intervals[0].fn()
  await Promise.resolve()
  expect(t.sent).toEqual([CH, CH])
})

test('createTypingController は同じチャンネルで二重に開始しない', () => {
  const t = typingApi()
  const f = fakeTimers()
  const c = createTypingController(t.api, { timers: f.timers })
  c.start(CH)
  c.start(CH)
  expect(f.intervals).toHaveLength(1)
})

test('createTypingController は停止でタイマーを解除する', () => {
  const t = typingApi()
  const f = fakeTimers()
  const c = createTypingController(t.api, { timers: f.timers })
  c.start(CH)
  c.stop(CH)
  expect(f.intervals[0].cleared).toBe(true)
  expect(f.timeouts[0].cleared).toBe(true)
})

test('createTypingController は停止後に再度開始できる', () => {
  const t = typingApi()
  const f = fakeTimers()
  const c = createTypingController(t.api, { timers: f.timers })
  c.start(CH)
  c.stop(CH)
  c.start(CH)
  expect(f.intervals).toHaveLength(2)
})

test('createTypingController は安全弁で自動停止する', () => {
  const t = typingApi()
  const f = fakeTimers()
  const c = createTypingController(t.api, { timers: f.timers })
  c.start(CH)
  f.timeouts[0].fn()
  expect(f.intervals[0].cleared).toBe(true)
})

test('createTypingController は stopAll で全チャンネルを止める', () => {
  const t = typingApi()
  const f = fakeTimers()
  const c = createTypingController(t.api, { timers: f.timers })
  c.start(CH)
  c.start(THREAD)
  c.stopAll()
  expect(f.intervals.every((i) => i.cleared)).toBe(true)
})

// --- createProgressTarget ---

type Posted = { channelId: string; payload: Record<string, unknown> }

function threadApi(over: Record<string, unknown> = {}) {
  const posted: Posted[] = []
  const threads: Array<{ channelId: string; messageId: string; payload: Record<string, unknown> }> = []
  const api = {
    createMessage: async (channelId: string, payload: Record<string, unknown>) => {
      posted.push({ channelId, payload })
      return { ok: true as const, value: { id: ANCHOR } }
    },
    startThread: async (channelId: string, messageId: string, payload: Record<string, unknown>) => {
      threads.push({ channelId, messageId, payload })
      return { ok: true as const, value: { id: THREAD } }
    },
    ...over,
  } as unknown as DiscordClient
  return { api, posted, threads }
}

const TS = new Date('2026-08-23T11:00:00Z')

test('createProgressTarget は DM をそのまま宛先にする', async () => {
  const a = threadApi()
  const target = await createProgressTarget(a.api, { chatId: CH, kind: 'dm', parentId: CH, content: 'hi', ts: TS })
  expect(target).toEqual({ id: CH, parent: CH, kind: 'dm' })
  expect(a.posted).toHaveLength(0)
})

test('createProgressTarget はスレッド内の inbound をそのスレッドへ向ける', async () => {
  const a = threadApi()
  const target = await createProgressTarget(a.api, { chatId: THREAD, kind: 'guild', parentId: CH, content: 'hi', ts: TS })
  expect(target).toEqual({ id: THREAD, parent: CH, kind: 'guild' })
  expect(a.posted).toHaveLength(0)
})

test('createProgressTarget はチャンネルの inbound でアンカーを投稿してスレッドを作る', async () => {
  const a = threadApi()
  const target = await createProgressTarget(a.api, { chatId: CH, kind: 'guild', parentId: CH, content: 'ping', ts: TS })
  expect(target).toEqual({ id: THREAD, parent: CH, kind: 'guild' })
  // アンカーは通知を出さない ZWSP 1 文字である
  expect(a.posted[0].payload).toEqual({ content: '​', flags: 4096, allowed_mentions: { parse: [] } })
  expect(a.threads[0].messageId).toBe(ANCHOR)
  expect(a.threads[0].payload.auto_archive_duration).toBe(60)
  expect(String(a.threads[0].payload.name)).toContain('ping')
})

test('createProgressTarget はアンカー投稿に失敗したら親チャンネルへ退避する', async () => {
  const a = threadApi({ createMessage: async () => ({ ok: false as const, error: 'http 403' }) })
  const target = await createProgressTarget(a.api, { chatId: CH, kind: 'guild', parentId: CH, content: 'ping', ts: TS })
  expect(target).toEqual({ id: CH, parent: CH, kind: 'guild' })
})

test('createProgressTarget はスレッド作成に失敗したら親チャンネルへ退避する', async () => {
  const a = threadApi({ startThread: async () => ({ ok: false as const, error: 'http 403' }) })
  const target = await createProgressTarget(a.api, { chatId: CH, kind: 'guild', parentId: CH, content: 'ping', ts: TS })
  expect(target).toEqual({ id: CH, parent: CH, kind: 'guild' })
})
