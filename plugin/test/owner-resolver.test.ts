import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createOwnerResolver } from '../src/owner-resolver'
import { readRoute, writeRoute } from '../src/routes'
import { readProgressBody, readTarget, writeProgressBody, writeTarget, type ProgressTarget } from '../src/progress-target'
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
  rmSync(testTmpDir, { recursive: true, force: true })
  if (savedStateDir === undefined) delete process.env.DISCORD_STATE_DIR
  else process.env.DISCORD_STATE_DIR = savedStateDir
})

const OWNER = 'proj'
const CH = '33333333333333333'
const OTHER_CH = '66666666666666666'
const GUILD = '11111111111111111'
const THREAD = '44444444444444444'
const ACT = 'b'.repeat(32)
const DM_ACT = 'c'.repeat(32)
const RUN = 'a'.repeat(32)
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
    now: () => NOW,
    log: (m: string) => void logs.push(m),
  })
  return { r, logs }
}

// --- 解決 ---

test('createOwnerResolver は担当が 1 件なら route を書く', async () => {
  const { r } = resolver()
  await r.resolve()
  expect(r.channelId()).toBe(CH)
  expect(r.guildId()).toBe(GUILD)
  expect(readRoute(OWNER)).toBe(CH)
})

test('createOwnerResolver は担当が変わらなければ route を書き直さない', async () => {
  let writes = 0
  const { r } = resolver({
    api: {
      getGuildChannels: async () => {
        writes++
        return { ok: true as const, value: [{ id: CH, name: 'proj', type: 0 }] }
      },
    },
  })
  await r.resolve()
  writeRoute(OWNER, 'sentinel-check')
  await r.resolve()
  // 2 周期目は担当が同じなので route を書き直さない
  expect(readRoute(OWNER)).toBe('sentinel-check')
  expect(writes).toBe(2)
})

test('createOwnerResolver は担当が別チャンネルへ移ったら route と guild の宛先を消す', async () => {
  // 担当名に一致するチャンネルが 別 id へ移る (どちらも access.groups にある)
  let channels = [{ id: CH, name: 'proj', type: 0 }]
  const r = createOwnerResolver({
    api: fakeApi({ getGuildChannels: async () => ({ ok: true, value: channels }) }),
    access: () => ({ allowFrom: [], groups: { [CH]: {}, [OTHER_CH]: {} } }) as Access,
    owner: OWNER,
    now: () => NOW,
  })
  await r.resolve()
  writeTarget(OWNER, target())
  writeProgressBody(OWNER, THREAD)

  channels = [{ id: OTHER_CH, name: 'proj', type: 0 }]
  await r.resolve()
  expect(r.channelId()).toBe(OTHER_CH)
  expect(readRoute(OWNER)).toBe(OTHER_CH)
  expect(readTarget(OWNER, ACT)).toBe(null)
  expect(readProgressBody(OWNER)).toBe(null)
})

test('createOwnerResolver は起動直後の確定では宛先を消さない', async () => {
  // 同じ担当で並走する他セッションの宛先を巻き込まないため 初回は route だけ書く
  writeTarget(OWNER, target())
  writeProgressBody(OWNER, THREAD)
  const { r } = resolver()
  await r.resolve()
  expect(readRoute(OWNER)).toBe(CH)
  expect(readTarget(OWNER, ACT)).not.toBe(null)
  expect(readProgressBody(OWNER)).toBe(THREAD)
})

// --- 無効化 ---

test('createOwnerResolver は access.groups から外れた担当を REST を待たずに無効化する', async () => {
  const { r } = resolver()
  await r.resolve()
  writeTarget(OWNER, target())

  let restCalled = false
  const dropped = createOwnerResolver({
    api: fakeApi({
      getGuilds: async () => {
        restCalled = true
        return { ok: true as const, value: [{ id: GUILD }] }
      },
    }),
    access: () => ({ allowFrom: [], groups: {} }),
    owner: OWNER,
    now: () => NOW,
  })
  // 直前の担当を持たせるため 1 度解決してから access を空にする
  await dropped.resolve()
  expect(dropped.channelId()).toBe(null)
  expect(readRoute(OWNER)).toBe(null)
  expect(restCalled).toBe(true)
})

test('createOwnerResolver は担当が未解決なら route を消す', async () => {
  const { r } = resolver()
  await r.resolve()
  const gone = resolver({ api: { getGuildChannels: async () => ({ ok: true, value: [] }) } })
  await gone.r.resolve()
  expect(gone.r.channelId()).toBe(null)
  expect(readRoute(OWNER)).toBe(null)
})

test('createOwnerResolver は担当が曖昧なら route を消して警告する', async () => {
  const ambiguous = resolver({
    api: { getGuildChannels: async () => ({ ok: true, value: [{ id: CH, name: 'proj', type: 0 }, { id: OTHER_CH, name: 'Proj', type: 0 }] }) },
    access: () => ({ allowFrom: [], groups: { [CH]: {}, [OTHER_CH]: {} } }),
  })
  writeRoute(OWNER, CH)
  await ambiguous.r.resolve()
  expect(ambiguous.r.channelId()).toBe(null)
  expect(readRoute(OWNER)).toBe(null)
  expect(ambiguous.logs.join(' ')).toContain('ambiguous')
})

// --- 取得失敗 ---

test('createOwnerResolver は guild 一覧の取得に失敗したら据え置く', async () => {
  const { r } = resolver()
  await r.resolve()
  const failing = resolver({ api: { getGuilds: async () => ({ ok: false, error: 'http 500' }) } })
  await failing.r.resolve()
  expect(readRoute(OWNER)).toBe(CH)
})

test('createOwnerResolver はチャンネル一覧の取得に失敗したら据え置く', async () => {
  const { r } = resolver()
  await r.resolve()
  const failing = resolver({ api: { getGuildChannels: async () => ({ ok: false, error: 'http 500' }) } })
  await failing.r.resolve()
  expect(readRoute(OWNER)).toBe(CH)
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
