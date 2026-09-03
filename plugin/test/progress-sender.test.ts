import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createProgressSender } from '../src/progress-sender'
import { writeHeartbeat, writePointer, type Pointer } from '../src/activation'
import { writeTarget, type ProgressTarget } from '../src/progress-target'
import type { ApiResult, DiscordClient } from '../src/discord-api'
import type { Access } from '../src/access'

const testTmpDir = join(tmpdir(), `discord-sender-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`)
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
const PID = 4321
const RUN = 'a'.repeat(32)
const ACT = 'b'.repeat(32)
const SESSION = '57db69e6-bf68-407b-8958-680297cb447f'
const CH = '33333333333333333'
const THREAD = '44444444444444444'
const GUILD = '11111111111111111'
const DM_CH = '77777777777777777'
const USER = '258152380355444736'
const MSG = '99999999999999999'
const NOW = 1_800_000_000_000

function pointer(over: Partial<Pointer> = {}): Pointer {
  return {
    claude_pid: PID,
    run_id: RUN,
    session_id: SESSION,
    activation_id: ACT,
    transcript_path: 'C:\\t.jsonl',
    source: 'startup',
    written_at: NOW,
    ...over,
  }
}

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

// 担当チャンネル proj が 1 件だけ見つかる guild 構成
const ACCESS: Access = { allowFrom: [USER], groups: { [CH]: {} } }
const GUILD_CHANNELS = [{ id: CH, name: 'proj', type: 0 }, { id: '66666666666666666', name: 'other', type: 0 }]

type Posted = { channelId: string; payload: Record<string, unknown> }

function fakeApi(over: Record<string, unknown> = {}) {
  const posted: Posted[] = []
  const channels: Record<string, Record<string, unknown>> = {
    [THREAD]: { id: THREAD, type: 11, parent_id: CH },
    [CH]: { id: CH, type: 0 },
    [DM_CH]: { id: DM_CH, type: 1, recipients: [{ id: USER }] },
  }
  const api = {
    getChannel: async (id: string): Promise<ApiResult<Record<string, unknown>>> =>
      channels[id] ? { ok: true, value: channels[id] } : { ok: false, error: 'http 404' },
    getGuilds: async () => ({ ok: true as const, value: [{ id: GUILD }] }),
    getGuildChannels: async () => ({ ok: true as const, value: GUILD_CHANNELS }),
    createMessage: async (channelId: string, payload: Record<string, unknown>) => {
      posted.push({ channelId, payload })
      return { ok: true as const, value: { id: '10000000000000001' } }
    },
    ...over,
  } as unknown as DiscordClient
  return { api, posted, channels }
}

function sender(over: Record<string, unknown> = {}) {
  const f = fakeApi((over.api as Record<string, unknown>) ?? {})
  const waits: number[] = []
  const s = createProgressSender({
    api: f.api,
    access: () => (over.access as Access) ?? ACCESS,
    owner: (over.owner as string) ?? OWNER,
    claudePid: PID,
    runId: RUN,
    activationId: ACT,
    now: () => NOW,
    sleep: async (ms: number) => {
      waits.push(ms)
      await (over.onWait as (() => Promise<void>) | undefined)?.()
    },
  })
  return { send: s.send, posted: f.posted, waits, channels: f.channels }
}

// 有効な activation と宛先を用意する
function setupActive(): void {
  writePointer(pointer())
  writeHeartbeat(PID, RUN, NOW)
  writeTarget(OWNER, target())
}

// --- 送信 ---

test('createProgressSender は有効な宛先へ投稿する', async () => {
  setupActive()
  const s = sender()
  expect(await s.send('progress')).toBe('sent')
  expect(s.posted).toHaveLength(1)
  expect(s.posted[0].channelId).toBe(THREAD)
  expect(s.posted[0].payload.content).toBe('progress')
  // 進捗は通知を出さず メンションも解決しない
  expect(s.posted[0].payload.flags).toBe(4096)
  expect(s.posted[0].payload.allowed_mentions).toEqual({ parse: [] })
})

test('createProgressSender は gate の待ちの間に差し替わった宛先へ送り直す', async () => {
  // 次の inbound が .meta を上書きしたのに気付かず 前のスレッドへ投稿するのを防ぐ
  setupActive()
  const nextThread = '20000000000000002'
  let swapped = false
  const s = sender({
    api: {
      getGuilds: async () => {
        if (!swapped) {
          swapped = true
          writeTarget(OWNER, target({ id: nextThread }))
        }
        return { ok: true as const, value: [{ id: GUILD }] }
      },
    },
  })
  s.channels[nextThread] = { id: nextThread, type: 11, parent_id: CH }

  expect(await s.send('progress')).toBe('sent')
  expect(s.posted).toHaveLength(1)
  expect(s.posted[0].channelId).toBe(nextThread)
})

test('createProgressSender は空の本文を送らない', async () => {
  setupActive()
  const s = sender()
  expect(await s.send('   ')).toBe('dropped')
  expect(s.posted).toHaveLength(0)
})

test('createProgressSender は 1900 コードポイントで切り詰める', async () => {
  setupActive()
  const s = sender()
  await s.send('あ'.repeat(2000))
  expect([...(s.posted[0].payload.content as string)]).toHaveLength(1900)
})

test('createProgressSender の切り詰めはサロゲートペアを分断しない', async () => {
  setupActive()
  const s = sender()
  await s.send('a'.repeat(1899) + '😀😀')
  expect(s.posted[0].payload.content).toBe('a'.repeat(1899) + '😀')
})

// --- activation の確認 ---

test('createProgressSender は heartbeat が無ければ終了を返す', async () => {
  writePointer(pointer())
  writeTarget(OWNER, target())
  const s = sender()
  expect(await s.send('x')).toBe('terminated')
  expect(s.posted).toHaveLength(0)
})

test('createProgressSender は heartbeat が失効していれば終了を返す', async () => {
  writePointer(pointer())
  writeHeartbeat(PID, RUN, NOW - 15_001)
  writeTarget(OWNER, target())
  const s = sender()
  expect(await s.send('x')).toBe('terminated')
})

test('createProgressSender はポインタの activation が変わっていれば終了を返す', async () => {
  writePointer(pointer({ activation_id: 'c'.repeat(32) }))
  writeHeartbeat(PID, RUN, NOW)
  writeTarget(OWNER, target())
  const s = sender()
  expect(await s.send('x')).toBe('terminated')
})

test('createProgressSender はポインタが無ければ終了を返す', async () => {
  writeHeartbeat(PID, RUN, NOW)
  writeTarget(OWNER, target())
  const s = sender()
  expect(await s.send('x')).toBe('terminated')
})

// --- 宛先の有効判定 ---

test('createProgressSender は宛先が無ければ破棄する', async () => {
  writePointer(pointer())
  writeHeartbeat(PID, RUN, NOW)
  const s = sender()
  expect(await s.send('x')).toBe('dropped')
})

test('createProgressSender は 12 時間を過ぎた宛先へ送らない', async () => {
  writePointer(pointer())
  writeHeartbeat(PID, RUN, NOW)
  writeTarget(OWNER, target({ written_at: NOW - 12 * 60 * 60 * 1000 - 1 }))
  const s = sender()
  expect(await s.send('x')).toBe('dropped')
})

// --- outbound gate ---

test('outbound gate は担当が別チャンネルへ移っていたら送らない', async () => {
  setupActive()
  // 担当名に一致するチャンネルが別 id になった状態
  const s = sender({ api: { getGuildChannels: async () => ({ ok: true, value: [{ id: '66666666666666666', name: 'proj', type: 0 }] }) }, access: { allowFrom: [USER], groups: { '66666666666666666': {} } } })
  expect(await s.send('x')).toBe('dropped')
  expect(s.posted).toHaveLength(0)
})

test('outbound gate は担当候補が複数なら送らない', async () => {
  setupActive()
  const s = sender({
    api: { getGuildChannels: async () => ({ ok: true, value: [{ id: CH, name: 'proj', type: 0 }, { id: '66666666666666666', name: 'Proj', type: 0 }] }) },
    access: { allowFrom: [USER], groups: { [CH]: {}, '66666666666666666': {} } },
  })
  expect(await s.send('x')).toBe('dropped')
})

test('outbound gate は担当が access.groups から外れたら送らない', async () => {
  setupActive()
  const s = sender({ access: { allowFrom: [USER], groups: {} } })
  expect(await s.send('x')).toBe('dropped')
})

test('outbound gate はチャンネル取得に失敗したら送らない', async () => {
  setupActive()
  const s = sender({ api: { getChannel: async () => ({ ok: false, error: 'http 403' }) } })
  expect(await s.send('x')).toBe('dropped')
})

test('outbound gate は取得した実体の id が食い違えば送らない', async () => {
  setupActive()
  const s = sender({ api: { getChannel: async () => ({ ok: true, value: { id: '66666666666666666', type: 0 } }) } })
  expect(await s.send('x')).toBe('dropped')
})

test('outbound gate は guild 一覧の取得に失敗したら送らない', async () => {
  setupActive()
  const s = sender({ api: { getGuilds: async () => ({ ok: false, error: 'http 500' }) } })
  expect(await s.send('x')).toBe('dropped')
})

test('outbound gate は DM 担当のセッションだけに DM を許す', async () => {
  writePointer(pointer())
  writeHeartbeat(PID, RUN, NOW)
  writeTarget('cc-discord', target({ id: DM_CH, parent: DM_CH, kind: 'dm' }))
  const s = sender({ owner: 'cc-discord' })
  expect(await s.send('x')).toBe('sent')
  expect(s.posted[0].channelId).toBe(DM_CH)
})

test('outbound gate は DM 担当でないセッションの DM 宛の宛先を拒む', async () => {
  writePointer(pointer())
  writeHeartbeat(PID, RUN, NOW)
  writeTarget(OWNER, target({ id: DM_CH, parent: DM_CH, kind: 'dm' }))
  const s = sender()
  expect(await s.send('x')).toBe('dropped')
})

test('outbound gate は allowFrom から外れた DM へ送らない', async () => {
  writePointer(pointer())
  writeHeartbeat(PID, RUN, NOW)
  writeTarget('cc-discord', target({ id: DM_CH, parent: DM_CH, kind: 'dm' }))
  const s = sender({ owner: 'cc-discord', access: { allowFrom: [], groups: { [CH]: {} } } })
  expect(await s.send('x')).toBe('dropped')
})

test('outbound gate はチャンネル直下の宛先も担当と照合する', async () => {
  writePointer(pointer())
  writeHeartbeat(PID, RUN, NOW)
  writeTarget(OWNER, target({ id: CH, parent: CH }))
  const s = sender()
  expect(await s.send('x')).toBe('sent')
})

// --- 判定の途中で activation が変わる場合 ---

test('gate の REST 待ちの間に activation が切り替わったら POST しない', async () => {
  setupActive()
  const s = sender({
    api: {
      getGuilds: async () => {
        // REST の待ち時間に相当する隙で ポインタが置き換わる
        writePointer(pointer({ activation_id: 'c'.repeat(32) }))
        return { ok: true as const, value: [{ id: GUILD }] }
      },
    },
  })
  expect(await s.send('x')).toBe('terminated')
  expect(s.posted).toHaveLength(0)
})

// --- 429 の再送 ---

test('429 は待機してから activation と gate をやり直して再送する', async () => {
  setupActive()
  let calls = 0
  const s = sender({
    api: {
      createMessage: async (channelId: string, payload: Record<string, unknown>) => {
        calls++
        if (calls === 1) return { ok: false as const, error: 'rate limited', retryAfterMs: 1500 }
        return { ok: true as const, value: { id: '1' } }
      },
    },
  })
  expect(await s.send('x')).toBe('sent')
  expect(s.waits).toEqual([1500])
  expect(calls).toBe(2)
})

test('429 の待機中に activation が変わったら再送しない', async () => {
  setupActive()
  let calls = 0
  const s = sender({
    api: {
      createMessage: async () => {
        calls++
        return { ok: false as const, error: 'rate limited', retryAfterMs: 100 }
      },
    },
    onWait: async () => {
      writePointer(pointer({ activation_id: 'c'.repeat(32) }))
    },
  })
  expect(await s.send('x')).toBe('terminated')
  expect(calls).toBe(1)
})

test('429 の待機中に allowlist が変わったら再送しない', async () => {
  setupActive()
  let calls = 0
  let groups: Record<string, unknown> = { [CH]: {} }
  const f = fakeApi({
    createMessage: async () => {
      calls++
      return { ok: false as const, error: 'rate limited', retryAfterMs: 100 }
    },
  })
  // access は送信のたびに読み直すため 待機中の変更が再送前の gate に効く
  const s = createProgressSender({
    api: f.api,
    access: () => ({ allowFrom: [USER], groups }) as Access,
    owner: OWNER,
    claudePid: PID,
    runId: RUN,
    activationId: ACT,
    now: () => NOW,
    sleep: async () => {
      groups = {}
    },
  })
  expect(await s.send('x')).toBe('dropped')
  expect(calls).toBe(1)
})

test('429 以外の失敗は再送しない', async () => {
  setupActive()
  let calls = 0
  const s = sender({
    api: {
      createMessage: async () => {
        calls++
        return { ok: false as const, error: 'http 500' }
      },
    },
  })
  expect(await s.send('x')).toBe('dropped')
  expect(calls).toBe(1)
})

test('429 の待ち時間が上限を超えるなら待たずに諦める', async () => {
  setupActive()
  let calls = 0
  const s = sender({
    api: {
      createMessage: async () => {
        calls++
        return { ok: false as const, error: 'rate limited', retryAfterMs: 60_000 }
      },
    },
  })
  expect(await s.send('x')).toBe('dropped')
  expect(s.waits).toEqual([])
  expect(calls).toBe(1)
})
