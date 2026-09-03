import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { parseSessionStart, planActivation, runSessionStart } from '../src/session-start'
import { readPointer, writePointer, type Pointer } from '../src/activation'

const testTmpDir = join(tmpdir(), `discord-start-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`)
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

const PID = 4321
const RUN = 'a'.repeat(32)
const ACT = 'b'.repeat(32)
const NEW_ACT = 'c'.repeat(32)
const SESSION = '57db69e6-bf68-407b-8958-680297cb447f'
const OTHER_SESSION = '11111111-2222-3333-4444-555555555555'
const TRANSCRIPT = 'C:\\transcripts\\x.jsonl'
const NOW = 1_800_000_000_000

function pointer(over: Partial<Pointer> = {}): Pointer {
  return {
    claude_pid: PID,
    run_id: RUN,
    session_id: SESSION,
    activation_id: ACT,
    transcript_path: TRANSCRIPT,
    source: 'startup',
    written_at: NOW - 1000,
    ...over,
  }
}

// --- parseSessionStart ---

const stdin = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ session_id: SESSION, transcript_path: TRANSCRIPT, source: 'startup', ...over })

test('parseSessionStart は stdin と環境変数から入力を組み立てる', () => {
  expect(parseSessionStart(stdin(), { CLAUDE_PID: String(PID), CC_DISCORD_RUN_ID: RUN })).toEqual({
    claudePid: PID,
    runId: RUN,
    sessionId: SESSION,
    transcriptPath: TRANSCRIPT,
    source: 'startup',
  })
})

test('parseSessionStart は run_id が無くても入力を組み立てる', () => {
  expect(parseSessionStart(stdin(), { CLAUDE_PID: String(PID) })?.runId).toBe(null)
})

test('parseSessionStart は形式の合わない run_id を持たないものとして扱う', () => {
  // そのまま通すと watcher の引数検証で弾かれ 進捗の転送が理由の分からないまま止まる
  const env = (v: string): NodeJS.ProcessEnv => ({ CLAUDE_PID: String(PID), CC_DISCORD_RUN_ID: v })
  expect(parseSessionStart(stdin(), env('not-hex'))?.runId).toBe(null)
  expect(parseSessionStart(stdin(), env('a'.repeat(31)))?.runId).toBe(null)
  expect(parseSessionStart(stdin(), env('A'.repeat(32)))?.runId).toBe(null)
})

test('parseSessionStart は model が文字列のときだけ取り込む', () => {
  expect(parseSessionStart(stdin({ model: 'opus[1m]' }), { CLAUDE_PID: String(PID) })?.model).toBe('opus[1m]')
  expect(parseSessionStart(stdin({ model: { id: 'x' } }), { CLAUDE_PID: String(PID) })?.model).toBeUndefined()
})

test('parseSessionStart は CLAUDE_PID が無ければ null を返す', () => {
  expect(parseSessionStart(stdin(), {})).toBe(null)
  expect(parseSessionStart(stdin(), { CLAUDE_PID: 'abc' })).toBe(null)
})

test('parseSessionStart は session_id や transcript_path が不正なら null を返す', () => {
  expect(parseSessionStart(stdin({ session_id: 'not-uuid' }), { CLAUDE_PID: String(PID) })).toBe(null)
  expect(parseSessionStart(stdin({ transcript_path: '' }), { CLAUDE_PID: String(PID) })).toBe(null)
})

test('parseSessionStart は未知の source を拒否する', () => {
  expect(parseSessionStart(stdin({ source: 'unknown' }), { CLAUDE_PID: String(PID) })).toBe(null)
})

test('parseSessionStart は解析できない stdin で null を返す', () => {
  expect(parseSessionStart('{ broken', { CLAUDE_PID: String(PID) })).toBe(null)
})

// --- planActivation ---

const base = {
  claudePid: PID,
  runId: RUN,
  sessionId: SESSION,
  transcriptPath: TRANSCRIPT,
  now: NOW,
  newActivationId: () => NEW_ACT,
}

test('planActivation は startup で新しい activation を作る', () => {
  const plan = planActivation({ ...base, source: 'startup', existing: null })
  expect(plan.isNew).toBe(true)
  expect(plan.pointer.activation_id).toBe(NEW_ACT)
  expect(plan.pointer.written_at).toBe(NOW)
})

test('planActivation は resume と clear と fork でも新しい activation を作る', () => {
  for (const source of ['resume', 'clear', 'fork'] as const) {
    expect(planActivation({ ...base, source, existing: pointer() }).isNew).toBe(true)
  }
})

test('planActivation は compact で同じ run と session なら activation を維持する', () => {
  const plan = planActivation({ ...base, source: 'compact', existing: pointer() })
  expect(plan.isNew).toBe(false)
  expect(plan.pointer.activation_id).toBe(ACT)
  expect(plan.pointer.transcript_path).toBe(TRANSCRIPT)
  expect(plan.pointer.written_at).toBe(NOW)
})

test('planActivation は compact でも run_id が違えば新しい activation を作る', () => {
  const plan = planActivation({ ...base, source: 'compact', existing: pointer({ run_id: 'd'.repeat(32) }) })
  expect(plan.isNew).toBe(true)
})

test('planActivation は compact でも session_id が違えば新しい activation を作る', () => {
  const plan = planActivation({ ...base, source: 'compact', existing: pointer({ session_id: OTHER_SESSION }) })
  expect(plan.isNew).toBe(true)
})

test('planActivation は compact で既存ポインタが無ければ新しい activation を作る', () => {
  expect(planActivation({ ...base, source: 'compact', existing: null }).isNew).toBe(true)
})

test('planActivation は run_id を持たない起動でも compact の維持を判定する', () => {
  const plan = planActivation({
    ...base,
    runId: null,
    source: 'compact',
    existing: pointer({ run_id: null }),
  })
  expect(plan.isNew).toBe(false)
})

// --- runSessionStart ---

function harness(over: Record<string, unknown> = {}) {
  const spawned: string[][] = []
  const order: string[] = []
  return {
    spawned,
    order,
    deps: {
      spawnWatcher: (args: string[]) => void spawned.push(args),
      sweep: () => void order.push('sweep'),
      newActivationId: () => NEW_ACT,
      now: () => NOW,
      log: () => {},
      ...over,
    },
  }
}

const input = { claudePid: PID, runId: RUN as string | null, sessionId: SESSION, transcriptPath: TRANSCRIPT, source: 'startup' as const }

test('runSessionStart はポインタを書いて watcher を起動する', () => {
  const h = harness()
  runSessionStart(input, h.deps)
  expect(readPointer(PID)?.activation_id).toBe(NEW_ACT)
  expect(h.spawned).toEqual([[TRANSCRIPT, SESSION, String(PID), RUN, NEW_ACT]])
})

test('runSessionStart は旧ポインタを置き換える', () => {
  writePointer(pointer())
  const h = harness()
  runSessionStart(input, h.deps)
  expect(readPointer(PID)?.activation_id).toBe(NEW_ACT)
})

test('runSessionStart は run_id が無ければ watcher を起動しない', () => {
  const h = harness()
  runSessionStart({ ...input, runId: null }, h.deps)
  expect(readPointer(PID)?.run_id).toBe(null)
  expect(h.spawned).toEqual([])
})

test('runSessionStart は activation を維持する compact で watcher を起動しない', () => {
  writePointer(pointer())
  const h = harness()
  runSessionStart({ ...input, source: 'compact' }, h.deps)
  expect(readPointer(PID)?.activation_id).toBe(ACT)
  expect(h.spawned).toEqual([])
})

test('runSessionStart は activation を維持できない compact で watcher を起動する', () => {
  writePointer(pointer({ session_id: OTHER_SESSION }))
  const h = harness()
  runSessionStart({ ...input, source: 'compact' }, h.deps)
  expect(h.spawned).toHaveLength(1)
})

test('runSessionStart はポインタを書けなければ watcher を起動しない', () => {
  const h = harness()
  // 書き込み先を壊して失敗させる (state dir を消しても作り直されるため PID を不正にする)
  runSessionStart({ ...input, claudePid: Number.NaN }, h.deps)
  expect(h.spawned).toEqual([])
})

test('runSessionStart は掃除をポインタの置き換えの後に行う', () => {
  const h = harness({
    spawnWatcher: () => {},
  })
  const order: string[] = []
  runSessionStart(input, {
    ...h.deps,
    sweep: () => {
      // 掃除の時点で新しいポインタが読めることを確かめる
      order.push(readPointer(PID)?.activation_id ?? 'none')
    },
  })
  expect(order).toEqual([NEW_ACT])
})
