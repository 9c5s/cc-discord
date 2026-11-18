import { test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createOwnerResolver } from '../src/owner-resolver'
import * as progressTarget from '../src/progress-target'
import { readTarget, writeTarget, type ProgressTarget } from '../src/progress-target'
import type { ApiResult, DiscordClient } from '../src/discord-api'
import type { Access } from '../src/access'

const testTmpDir = join(tmpdir(), `discord-resolver-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`)
let savedStateDir: string | undefined

beforeEach(() => {
  savedStateDir = process.env.DISCORD_STATE_DIR
  process.env.DISCORD_STATE_DIR = join(testTmpDir, 'state')
  mkdirSync(process.env.DISCORD_STATE_DIR, { recursive: true })
})

afterEach(() => {
  mock.restore()
  rmSync(testTmpDir, { recursive: true, force: true })
  if (savedStateDir === undefined) delete process.env.DISCORD_STATE_DIR
  else process.env.DISCORD_STATE_DIR = savedStateDir
})

const OWNER = 'proj'
const CH = '33333333333333333'
const OTHER_CH = '66666666666666666'
const GUILD = '11111111111111111'
const THREAD = '44444444444444444'
const NEXT_THREAD = '88888888888888888'
const ACT = 'b'.repeat(32)
const DM_ACT = 'c'.repeat(32)
const NEXT_ACT = 'f'.repeat(32)
const RUN = 'a'.repeat(32)
const OTHER_ACT = 'd'.repeat(32)
const OTHER_RUN = 'e'.repeat(32)
const SESSION = '57db69e6-bf68-407b-8958-680297cb447f'
const MSG = '99999999999999999'
const NOW = 1_800_000_000_000

const ACCESS: Access = { allowFrom: [], groups: { [CH]: {} } }

function target(over: Partial<ProgressTarget> = {}): ProgressTarget {
  return {
    id: THREAD,
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

function fakeApi(over: Record<string, unknown> = {}) {
  const api = {
    getGuilds: async (): Promise<ApiResult<Array<{ id: string }>>> => ({ ok: true, value: [{ id: GUILD }] }),
    getGuildChannels: async () => ({ ok: true as const, value: [{ id: CH, name: 'proj', type: 0 }] }),
    ...over,
  } as unknown as DiscordClient
  return api
}

function resolver(over: Record<string, unknown> = {}) {
  const logs: string[] = []
  const r = createOwnerResolver({
    api: fakeApi((over.api as Record<string, unknown>) ?? {}),
    access: (over.access as () => Access) ?? (() => ACCESS),
    owner: OWNER,
    runId: 'runId' in over ? (over.runId as string | null) : RUN,
    now: (over.now as () => number) ?? (() => NOW),
    log: (m: string) => void logs.push(m),
  })
  return { r, logs }
}

// 担当名に一致するチャンネルと取得の成否を途中で切り替えられる resolver を作る
// 移る先のチャンネルも access.groups に入れておく
function switchable() {
  const s = { channels: [{ id: CH, name: 'proj', type: 0 }], guildsFail: false, channelsFail: false }
  const r = createOwnerResolver({
    api: fakeApi({
      getGuilds: async () => (s.guildsFail ? { ok: false, error: 'http 500' } : { ok: true, value: [{ id: GUILD }] }),
      getGuildChannels: async () => (s.channelsFail ? { ok: false, error: 'http 500' } : { ok: true, value: s.channels }),
    }),
    access: () => ({ allowFrom: [], groups: { [CH]: {}, [OTHER_CH]: {} } }) as Access,
    owner: OWNER,
    runId: RUN,
    now: () => NOW,
  })
  return { r, s }
}

// --- 解決 ---

test('createOwnerResolver は担当が 1 件ならそれを担当にする', async () => {
  const { r } = resolver()
  await r.resolve()
  expect(r.channelId()).toBe(CH)
  expect(r.guildId()).toBe(GUILD)
})

test('createOwnerResolver は担当が別チャンネルへ移ったら自分の run の guild 宛先を消す', async () => {
  const { r, s } = switchable()
  await r.resolve()
  writeTarget(OWNER, target())
  writeTarget(OWNER, target({ run_id: OTHER_RUN, activation_id: OTHER_ACT }))

  s.channels = [{ id: OTHER_CH, name: 'proj', type: 0 }]
  await r.resolve()
  expect(r.channelId()).toBe(OTHER_CH)
  expect(readTarget(OWNER, ACT)).toBe(null)
  // 他のセッションは自分の resolver で同じ判断に至るため こちらからは触らない
  expect(readTarget(OWNER, OTHER_ACT)).not.toBe(null)
})

test('createOwnerResolver は担当を手放しても他の run の宛先は残す', async () => {
  // 同じ担当で並走する他セッションの進捗を止めないため 消すのは自分の run の宛先だけである
  const { r } = resolver()
  await r.resolve()
  writeTarget(OWNER, target())
  writeTarget(OWNER, target({ run_id: OTHER_RUN, activation_id: OTHER_ACT }))

  const gone = resolver({ api: { getGuildChannels: async () => ({ ok: true, value: [] }) } })
  await gone.r.resolve()
  expect(gone.r.channelId()).toBe(null)
  expect(readTarget(OWNER, ACT)).toBe(null)
  expect(readTarget(OWNER, OTHER_ACT)).not.toBe(null)
})

test('createOwnerResolver は起動直後の確定では担当チャンネル以外を指す自分の宛先だけを消す', async () => {
  // MCP だけが再起動されると 同じ run のまま担当を確定し直す
  writeTarget(OWNER, target())
  writeTarget(OWNER, target({ activation_id: NEXT_ACT, id: NEXT_THREAD, parent: OTHER_CH }))
  const { r } = resolver()
  await r.resolve()
  expect(readTarget(OWNER, ACT)).not.toBe(null)
  expect(readTarget(OWNER, NEXT_ACT)).toBe(null)
})

test('createOwnerResolver は担当名が空なら REST を呼ばない', async () => {
  // どのチャンネル名とも一致しないため 一覧を取っても結果は変わらず rate limit を削るだけになる
  let calls = 0
  const r = createOwnerResolver({
    api: fakeApi({
      getGuilds: async () => {
        calls++
        return { ok: true as const, value: [{ id: GUILD }] }
      },
    }),
    access: () => ACCESS,
    owner: '',
    runId: RUN,
    now: () => NOW,
  })
  await r.resolve()
  expect(calls).toBe(0)
  expect(r.channelId()).toBe(null)
})

// --- 無効化 ---

test('createOwnerResolver は access.groups から外れた担当を REST を待たずに無効化する', async () => {
  // 同じ resolver で access を変える (別インスタンスでは担当を持った状態の分岐を通らない)
  let groups: Access['groups'] = { [CH]: {} }
  let calls = 0
  let release = (): void => {}
  const gate = new Promise<void>((res) => {
    release = res
  })
  const r = createOwnerResolver({
    api: fakeApi({
      getGuilds: async () => {
        calls++
        // 2 周期目は REST を止めたままにして 判定だけが先に進むことを確かめる
        if (calls > 1) await gate
        return { ok: true as const, value: [{ id: GUILD }] }
      },
    }),
    access: () => ({ allowFrom: [], groups }) as Access,
    owner: OWNER,
    runId: RUN,
    now: () => NOW,
  })

  await r.resolve()
  expect(r.channelId()).toBe(CH)
  writeTarget(OWNER, target())

  groups = {}
  const pending = r.resolve()
  expect(r.channelId()).toBe(null)
  expect(readTarget(OWNER, ACT)).toBe(null)

  release()
  await pending
  expect(calls).toBe(2)
})

test('createOwnerResolver は担当が曖昧なら担当を持たずに警告する', async () => {
  const ambiguous = resolver({
    api: { getGuildChannels: async () => ({ ok: true, value: [{ id: CH, name: 'proj', type: 0 }, { id: OTHER_CH, name: 'Proj', type: 0 }] }) },
    access: () => ({ allowFrom: [], groups: { [CH]: {}, [OTHER_CH]: {} } }),
  })
  await ambiguous.r.resolve()
  expect(ambiguous.r.channelId()).toBe(null)
  expect(ambiguous.logs.join(' ')).toContain('ambiguous')
})

// --- 取得失敗 ---

test('createOwnerResolver は guild 一覧の取得に失敗したら据え置く', async () => {
  const { r, s } = switchable()
  await r.resolve()
  writeTarget(OWNER, target())
  s.guildsFail = true
  await r.resolve()
  expect(r.channelId()).toBe(CH)
  expect(readTarget(OWNER, ACT)).not.toBe(null)
})

test('createOwnerResolver はチャンネル一覧の取得に失敗したら据え置く', async () => {
  const { r, s } = switchable()
  await r.resolve()
  writeTarget(OWNER, target())
  s.channelsFail = true
  await r.resolve()
  expect(r.channelId()).toBe(CH)
  expect(readTarget(OWNER, ACT)).not.toBe(null)
})

// --- 削除の再試行 ---

test('createOwnerResolver は宛先の削除に失敗したら担当が変わらなくても次の周期で消し直す', async () => {
  const { r, s } = switchable()
  await r.resolve()
  writeTarget(OWNER, target())
  s.channels = [{ id: OTHER_CH, name: 'proj', type: 0 }]
  const failing = spyOn(progressTarget, 'deleteTarget').mockReturnValue(false)
  await r.resolve()
  failing.mockRestore()
  expect(readTarget(OWNER, ACT)).not.toBe(null)

  await r.resolve()
  expect(r.channelId()).toBe(OTHER_CH)
  expect(readTarget(OWNER, ACT)).toBe(null)
})

test('createOwnerResolver は消し直すときも担当チャンネルを指す宛先を残す', async () => {
  // 削除に失敗してから次の周期までに 移った先の inbound が宛先を書くことがある
  const { r, s } = switchable()
  await r.resolve()
  writeTarget(OWNER, target())
  s.channels = [{ id: OTHER_CH, name: 'proj', type: 0 }]
  const failing = spyOn(progressTarget, 'deleteTarget').mockReturnValue(false)
  await r.resolve()
  failing.mockRestore()
  writeTarget(OWNER, target({ activation_id: NEXT_ACT, id: NEXT_THREAD, parent: OTHER_CH }))

  await r.resolve()
  expect(readTarget(OWNER, NEXT_ACT)).not.toBe(null)
})

test('createOwnerResolver は担当を手放した周期に削除に失敗したら取得に失敗した周期でも消し直す', async () => {
  const { r, s } = switchable()
  await r.resolve()
  writeTarget(OWNER, target())
  s.channels = []
  const failing = spyOn(progressTarget, 'deleteTarget').mockReturnValue(false)
  await r.resolve()
  failing.mockRestore()
  expect(r.channelId()).toBe(null)
  expect(readTarget(OWNER, ACT)).not.toBe(null)

  s.guildsFail = true
  await r.resolve()
  expect(readTarget(OWNER, ACT)).toBe(null)
})

// --- DM と期限切れ ---

test('createOwnerResolver は DM の宛先を消さない', async () => {
  const { r } = resolver()
  await r.resolve()
  writeTarget(OWNER, target({ activation_id: DM_ACT, id: '77777777777777777', parent: '77777777777777777', kind: 'dm' }))
  const gone = resolver({ api: { getGuildChannels: async () => ({ ok: true, value: [] }) } })
  await gone.r.resolve()
  expect(readTarget(OWNER, DM_ACT)).not.toBe(null)
})

test('createOwnerResolver は 12 時間より古い宛先を掃除する', async () => {
  writeTarget(OWNER, target({ written_at: NOW - 12 * 60 * 60 * 1000 - 1 }))
  writeTarget(OWNER, target({ activation_id: DM_ACT, written_at: NOW }))
  const { r } = resolver()
  await r.resolve()
  expect(readTarget(OWNER, ACT)).toBe(null)
  expect(readTarget(OWNER, DM_ACT)).not.toBe(null)
})

// --- 並行実行 ---

test('createOwnerResolver は前の周期が終わるまで次を始めない', async () => {
  let started = 0
  let release: (() => void) | null = null
  const { r } = resolver({
    api: {
      getGuilds: async () => {
        started++
        await new Promise<void>((res) => {
          release = res
        })
        return { ok: true as const, value: [{ id: GUILD }] }
      },
    },
  })
  const first = r.resolve()
  await Promise.resolve()
  await r.resolve()
  expect(started).toBe(1)
  release?.()
  await first
})

// --- 取得失敗が続いたとき ---

// 1 回目だけ成功し 以後は guild 一覧の取得に失敗する resolver を作る
function failingAfterFirst(clock: () => number) {
  let calls = 0
  return resolver({
    now: clock,
    api: {
      getGuilds: async () => {
        calls++
        return calls === 1 ? { ok: true as const, value: [{ id: GUILD }] } : { ok: false as const, error: 'http 500' }
      },
    },
  })
}

test('createOwnerResolver は取得に失敗しても猶予の内は担当を保つ', async () => {
  let clock = NOW
  const { r } = failingAfterFirst(() => clock)
  await r.resolve()
  expect(r.channelId()).toBe(CH)
  writeTarget(OWNER, target())

  clock = NOW + 4 * 60_000
  await r.resolve()
  expect(r.channelId()).toBe(CH)
  expect(readTarget(OWNER, ACT)).not.toBe(null)
})

test('createOwnerResolver は取得の失敗が猶予を超えたら担当を手放す', async () => {
  let clock = NOW
  const { r } = failingAfterFirst(() => clock)
  await r.resolve()
  writeTarget(OWNER, target())

  clock = NOW + 6 * 60_000
  await r.resolve()
  expect(r.channelId()).toBeNull()
  expect(r.guildId()).toBeNull()
  expect(readTarget(OWNER, ACT)).toBeNull()
})

test('createOwnerResolver は解決に成功し直せば猶予を数え直す', async () => {
  let clock = NOW
  let fail = false
  const { r } = resolver({
    now: () => clock,
    api: {
      getGuilds: async () =>
        fail ? { ok: false as const, error: 'http 500' } : { ok: true as const, value: [{ id: GUILD }] },
    },
  })
  await r.resolve()

  fail = true
  clock = NOW + 4 * 60_000
  await r.resolve()
  fail = false
  clock = NOW + 5 * 60_000
  await r.resolve()

  fail = true
  clock = NOW + 9 * 60_000
  await r.resolve()
  expect(r.channelId()).toBe(CH)
})
