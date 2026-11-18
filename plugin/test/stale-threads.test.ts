import { test, expect } from 'bun:test'
import { STALE_MS, archiveStaleThreads, isStaleThread, type ThreadView } from '../src/stale-threads'

const CH = '33333333333333333'
const BOT = '55555555555555555'
const THREAD = '44444444444444444'

const DISCORD_EPOCH = 1_420_070_400_000
function snowflakeAt(ms: number): string {
  return String((BigInt(ms - DISCORD_EPOCH) << 22n) | 1n)
}

const HOUR = 60 * 60 * 1000
const NOW = 1_800_000_000_000
const OLD = NOW - 13 * HOUR
const ALMOST = NOW - (13 * HOUR - 60_000)

function thread(over: Partial<ThreadView> = {}): ThreadView {
  return {
    id: THREAD,
    parentId: CH,
    ownerId: BOT,
    name: '[08/23 11:00] ping',
    autoArchiveDuration: 60,
    lastMessageId: snowflakeAt(OLD),
    createdTimestamp: null,
    ...over,
  }
}

// --- isStaleThread ---

const opts = { parentId: CH, botId: BOT, currentTargetId: null, now: NOW }

test('STALE_MS は 13 時間である', () => {
  expect(STALE_MS).toBe(13 * HOUR)
})

test('isStaleThread は最終メッセージから 13 時間たったスレッドを対象にする', () => {
  expect(isStaleThread(thread(), opts)).toBe(true)
})

test('isStaleThread は最終メッセージから 12 時間 59 分のスレッドを対象にしない', () => {
  expect(isStaleThread(thread({ lastMessageId: snowflakeAt(ALMOST) }), opts)).toBe(false)
})

test('isStaleThread は担当チャンネル以外の子スレッドを除く', () => {
  expect(isStaleThread(thread({ parentId: '66666666666666666' }), opts)).toBe(false)
  expect(isStaleThread(thread({ parentId: null }), opts)).toBe(false)
})

test('isStaleThread は bot 以外が作ったスレッドを除く', () => {
  expect(isStaleThread(thread({ ownerId: '77777777777777777' }), opts)).toBe(false)
  expect(isStaleThread(thread({ ownerId: null }), opts)).toBe(false)
})

test('isStaleThread は名前の規約に合わないスレッドを除く', () => {
  expect(isStaleThread(thread({ name: 'random talk' }), opts)).toBe(false)
})

test('isStaleThread は自動 archive 時間が 60 でないスレッドを除く', () => {
  expect(isStaleThread(thread({ autoArchiveDuration: 1440 }), opts)).toBe(false)
  expect(isStaleThread(thread({ autoArchiveDuration: null }), opts)).toBe(false)
})

test('isStaleThread は現在の宛先のスレッドを除く', () => {
  expect(isStaleThread(thread(), { ...opts, currentTargetId: THREAD })).toBe(false)
  expect(isStaleThread(thread(), { ...opts, currentTargetId: '44444444444444445' })).toBe(true)
})

test('isStaleThread は最終メッセージが無ければ作成時刻で判定する', () => {
  expect(isStaleThread(thread({ lastMessageId: null, createdTimestamp: OLD }), opts)).toBe(true)
  expect(isStaleThread(thread({ lastMessageId: null, createdTimestamp: ALMOST }), opts)).toBe(false)
})

test('isStaleThread は最終メッセージも作成時刻も無ければスレッド id の生成時刻で判定する', () => {
  expect(isStaleThread(thread({ id: snowflakeAt(OLD), lastMessageId: null }), opts)).toBe(true)
  expect(isStaleThread(thread({ id: snowflakeAt(ALMOST), lastMessageId: null }), opts)).toBe(false)
})

test('isStaleThread は時刻を判定できないスレッドを除く', () => {
  expect(isStaleThread(thread({ id: 'x', lastMessageId: null }), opts)).toBe(false)
})

// --- archiveStaleThreads ---

function fakeOps(threads: ThreadView[], archive: (id: string) => Promise<boolean> = async () => true) {
  const archived: string[] = []
  return {
    archived,
    ops: {
      listActiveThreads: async () => threads,
      archive: async (id: string) => {
        archived.push(id)
        return archive(id)
      },
    },
  }
}

const args = { parentId: CH, botId: BOT, currentTargetId: null, now: NOW }

test('archiveStaleThreads は対象のスレッドだけを archive する', async () => {
  const o = fakeOps([thread(), thread({ id: '44444444444444445', lastMessageId: snowflakeAt(ALMOST) })])
  expect(await archiveStaleThreads(o.ops, args)).toEqual([THREAD])
  expect(o.archived).toEqual([THREAD])
})

test('archiveStaleThreads は現在の宛先のスレッドを閉じない', async () => {
  const o = fakeOps([thread()])
  expect(await archiveStaleThreads(o.ops, { ...args, currentTargetId: THREAD })).toEqual([])
  expect(o.archived).toEqual([])
})

test('archiveStaleThreads は archive が false を返したスレッドを結果に含めない', async () => {
  const other = '44444444444444446'
  const o = fakeOps([thread(), thread({ id: other })], async (id) => id === other)
  expect(await archiveStaleThreads(o.ops, args)).toEqual([other])
  expect(o.archived).toEqual([THREAD, other])
})

test('archiveStaleThreads は now を省略すると現在時刻で判定する', async () => {
  const o = fakeOps([thread({ lastMessageId: snowflakeAt(Date.now() - 14 * HOUR) })])
  expect(await archiveStaleThreads(o.ops, { parentId: CH, botId: BOT, currentTargetId: null })).toEqual([THREAD])
})
