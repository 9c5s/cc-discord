import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createProgressSender } from '../src/progress-sender'
import { readPointer, writeHeartbeat, writePointer, type Pointer } from '../src/activation'
import { readTarget, writeTarget, type ProgressTarget } from '../src/progress-target'
import { runSessionStart } from '../src/session-start'
import { cleanupRun } from '../src/proxy'
import { handleReply } from '../src/reply'
import type { ApiResult, DiscordClient } from '../src/discord-api'
import type { Access } from '../src/access'

// 複数のセッションと activation が絡む振る舞いを モジュールを組み合わせて確かめる
// 個々の判定は各モジュールのテストで固定しているため ここでは組み合わせの結果だけを見る

const testTmpDir = join(tmpdir(), `discord-scenario-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`)
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
const GUILD = '11111111111111111'
const THREAD_A = '44444444444444444'
const THREAD_B = '55555555555555555'
const MSG = '99999999999999999'
const USER = '258152380355444736'
const NOW = 1_800_000_000_000

const PID_A = 4321
const PID_B = 8765
const RUN_A = 'a'.repeat(32)
const RUN_B = 'd'.repeat(32)
const ACT_1 = 'b'.repeat(32)
const ACT_2 = 'c'.repeat(32)
const SESSION = '57db69e6-bf68-407b-8958-680297cb447f'
const SESSION_B = '11111111-2222-3333-4444-555555555555'

const ACCESS: Access = { allowFrom: [USER], groups: { [CH]: {} } }

function pointer(over: Partial<Pointer> = {}): Pointer {
  return {
    claude_pid: PID_A,
    run_id: RUN_A,
    session_id: SESSION,
    activation_id: ACT_1,
    transcript_path: 'C:\\t.jsonl',
    source: 'startup',
    written_at: NOW,
    ...over,
  }
}

function target(over: Partial<ProgressTarget> = {}): ProgressTarget {
  return {
    id: THREAD_A,
    parent: CH,
    kind: 'guild',
    session_id: SESSION,
    run_id: RUN_A,
    activation_id: ACT_1,
    message_id: MSG,
    written_at: NOW,
    ...over,
  }
}

function fakeApi() {
  const posted: Array<{ channelId: string }> = []
  const api = {
    getChannel: async (id: string): Promise<ApiResult<Record<string, unknown>>> =>
      id === CH
        ? { ok: true, value: { id: CH, type: 0 } }
        : { ok: true, value: { id, type: 11, parent_id: CH } },
    getGuilds: async () => ({ ok: true as const, value: [{ id: GUILD }] }),
    getGuildChannels: async () => ({ ok: true as const, value: [{ id: CH, name: OWNER, type: 0 }] }),
    createMessage: async (channelId: string) => {
      posted.push({ channelId })
      return { ok: true as const, value: { id: '10000000000000001' } }
    },
  } as unknown as DiscordClient
  return { api, posted }
}

function sender(
  api: DiscordClient,
  claudePid: number,
  runId: string,
  activationId: string,
  access: Access = ACCESS,
) {
  return createProgressSender({
    api,
    access: () => access,
    owner: OWNER,
    claudePid,
    runId,
    activationId,
    now: () => NOW,
    sleep: async () => {},
  })
}

// --- 複数セッションの並走 ---

test('同じ担当の 2 セッションはそれぞれ自分の宛先へ投稿する', async () => {
  writePointer(pointer())
  writePointer(pointer({ claude_pid: PID_B, run_id: RUN_B, session_id: SESSION_B, activation_id: ACT_2 }))
  writeHeartbeat(PID_A, RUN_A, NOW)
  writeHeartbeat(PID_B, RUN_B, NOW)
  writeTarget(OWNER, target())
  writeTarget(OWNER, target({ id: THREAD_B, session_id: SESSION_B, run_id: RUN_B, activation_id: ACT_2 }))

  const f = fakeApi()
  expect(await sender(f.api, PID_A, RUN_A, ACT_1).send('A の進捗')).toBe('sent')
  expect(await sender(f.api, PID_B, RUN_B, ACT_2).send('B の進捗')).toBe('sent')
  expect(f.posted.map((p) => p.channelId)).toEqual([THREAD_A, THREAD_B])
})

test('同じ session_id を 2 つのプロセスから resume しても宛先は互いを上書きしない', async () => {
  // activation が違えばファイル名が分かれる
  writeTarget(OWNER, target())
  writeTarget(OWNER, target({ id: THREAD_B, run_id: RUN_B, activation_id: ACT_2 }))
  expect(readTarget(OWNER, ACT_1)?.id).toBe(THREAD_A)
  expect(readTarget(OWNER, ACT_2)?.id).toBe(THREAD_B)
})

// --- activation の切り替え ---

test('同じプロセスの resume でポインタが置き換わると前の activation の送信は止まる', async () => {
  writePointer(pointer())
  writeHeartbeat(PID_A, RUN_A, NOW)
  writeTarget(OWNER, target())
  const f = fakeApi()
  const before = sender(f.api, PID_A, RUN_A, ACT_1)
  expect(await before.send('切り替え前')).toBe('sent')

  // resume で hook が新しい activation のポインタを書く
  runSessionStart(
    { claudePid: PID_A, runId: RUN_A, sessionId: SESSION, transcriptPath: 'C:\\t.jsonl', source: 'resume' },
    { spawnWatcher: () => {}, sweep: () => {}, newActivationId: () => ACT_2, now: () => NOW },
  )
  expect(await before.send('切り替え後')).toBe('terminated')
  expect(f.posted).toHaveLength(1)
})

test('compaction の前後では同じ宛先へ転送され続ける', async () => {
  writePointer(pointer())
  writeHeartbeat(PID_A, RUN_A, NOW)
  writeTarget(OWNER, target())
  const f = fakeApi()
  const s = sender(f.api, PID_A, RUN_A, ACT_1)
  expect(await s.send('compaction 前')).toBe('sent')

  runSessionStart(
    { claudePid: PID_A, runId: RUN_A, sessionId: SESSION, transcriptPath: 'C:\\t2.jsonl', source: 'compact' },
    { spawnWatcher: () => {}, sweep: () => {}, newActivationId: () => ACT_2, now: () => NOW },
  )
  expect(readPointer(PID_A)?.activation_id).toBe(ACT_1)
  expect(readPointer(PID_A)?.transcript_path).toBe('C:\\t2.jsonl')
  expect(await s.send('compaction 後')).toBe('sent')
  expect(f.posted.map((p) => p.channelId)).toEqual([THREAD_A, THREAD_A])
})

test('run_id を持たない起動で再開すると旧 watcher は止まり新 watcher は起動しない', async () => {
  writePointer(pointer())
  writeHeartbeat(PID_A, RUN_A, NOW)
  writeTarget(OWNER, target())
  const f = fakeApi()
  const old = sender(f.api, PID_A, RUN_A, ACT_1)

  const spawned: string[][] = []
  runSessionStart(
    { claudePid: PID_A, runId: null, sessionId: SESSION, transcriptPath: 'C:\\t.jsonl', source: 'resume' },
    { spawnWatcher: (args) => void spawned.push(args), sweep: () => {}, newActivationId: () => ACT_2, now: () => NOW },
  )
  expect(spawned).toEqual([])
  expect(await old.send('再開後')).toBe('terminated')
})

// --- 別の起動との分離 ---

test('前回起動のプロセスは新しい起動の宛先を消せない', () => {
  // 新しい起動 (RUN_B) が書いた宛先を 前回起動 (RUN_A) の終了処理が消さない
  writeTarget(OWNER, target({ run_id: RUN_B, activation_id: ACT_2 }))
  cleanupRun({ claudePid: PID_A, runId: RUN_A, owner: OWNER })
  expect(readTarget(OWNER, ACT_2)).not.toBe(null)
})

test('前回起動のポインタが残っていても新しい起動は現行にならない', async () => {
  // PID が再利用され 別の run が同じ PID でポインタを書いた状態
  writePointer(pointer({ run_id: RUN_B, activation_id: ACT_2 }))
  writeHeartbeat(PID_A, RUN_A, NOW)
  writeTarget(OWNER, target())
  const f = fakeApi()
  expect(await sender(f.api, PID_A, RUN_A, ACT_1).send('旧 run の進捗')).toBe('terminated')
  expect(f.posted).toHaveLength(0)
})

test('ポインタの置き換えに失敗した状態では旧 activation が現行のまま続く', async () => {
  // 受容リスクとして記録した経路である (hook が実行されない場合と同じ結果になる)
  writePointer(pointer())
  writeHeartbeat(PID_A, RUN_A, NOW)
  writeTarget(OWNER, target())
  const f = fakeApi()
  // hook が動かなければポインタは変わらず 旧 activation の送信は続く
  expect(await sender(f.api, PID_A, RUN_A, ACT_1).send('進捗')).toBe('sent')
  expect(f.posted).toHaveLength(1)
})

// --- 担当の分離 ---

const OWNER_B = 'other'
const CH_B = '66666666666666666'
const ACCESS_BOTH: Access = { allowFrom: [USER], groups: { [CH]: {}, [CH_B]: {} } }

// 2 つの担当チャンネルが登録済みの guild
function twoOwnerApi() {
  const posted: Array<{ channelId: string }> = []
  const api = {
    getChannel: async (id: string): Promise<ApiResult<Record<string, unknown>>> =>
      id === CH || id === CH_B
        ? { ok: true, value: { id, type: 0 } }
        : { ok: true, value: { id, type: 11, parent_id: CH } },
    getGuilds: async () => ({ ok: true as const, value: [{ id: GUILD }] }),
    getGuildChannels: async () => ({
      ok: true as const,
      value: [
        { id: CH, name: OWNER, type: 0 },
        { id: CH_B, name: OWNER_B, type: 0 },
      ],
    }),
    createMessage: async (channelId: string) => {
      posted.push({ channelId })
      return { ok: true as const, value: { id: '10000000000000001' } }
    },
  } as unknown as DiscordClient
  return { api, posted }
}

test('担当 A のセッションは登録済みでも担当 B のチャンネルへ返信しない', async () => {
  const f = twoOwnerApi()
  const res = await handleReply(
    { chat_id: CH_B, text: 'B のチャンネルへ' },
    {
      api: f.api,
      access: () => ACCESS_BOTH,
      footer: () => '',
      stopTyping: () => {},
      ownerCtx: { kind: 'named', owner: OWNER, dir: 'C:\example\proj' },
      ownerChannelId: () => CH,
    },
  )
  expect(res.isError).toBe(true)
  expect(f.posted).toEqual([])
})

test('担当 A のセッションは自分の担当チャンネルへは返信する', async () => {
  const f = twoOwnerApi()
  const res = await handleReply(
    { chat_id: CH, text: 'A のチャンネルへ' },
    {
      api: f.api,
      access: () => ACCESS_BOTH,
      footer: () => '',
      stopTyping: () => {},
      ownerCtx: { kind: 'named', owner: OWNER, dir: 'C:\example\proj' },
      ownerChannelId: () => CH,
    },
  )
  expect(res.isError).toBeUndefined()
  expect(f.posted.map((x) => x.channelId)).toEqual([CH])
})

test('宛先が担当 B のチャンネルを指していても進捗は送らない', async () => {
  writePointer(pointer())
  writeHeartbeat(PID_A, RUN_A, NOW)
  writeTarget(OWNER, target({ id: CH_B, parent: CH_B }))

  const f = twoOwnerApi()
  expect(await sender(f.api, PID_A, RUN_A, ACT_1, ACCESS_BOTH).send('B へ漏らさない')).toBe('dropped')
  expect(f.posted).toEqual([])
})
