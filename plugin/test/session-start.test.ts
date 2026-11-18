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
const ACT = 'b'.repeat(32)
const NEW_ACT = 'c'.repeat(32)
const SESSION = '57db69e6-bf68-407b-8958-680297cb447f'
const OTHER_SESSION = '11111111-2222-3333-4444-555555555555'
const TRANSCRIPT = 'C:\\transcripts\\x.jsonl'
const NOW = 1_800_000_000_000
const STARTED = 1_799_999_000_000

function pointer(over: Partial<Pointer> = {}): Pointer {
  return {
    claude_pid: PID,
    claude_started_at: STARTED,
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

test('parseSessionStart は stdin と環境変数から入力を組み立て run_id を取り込まない', () => {
  const input = parseSessionStart(stdin(), { CLAUDE_PID: String(PID), CC_DISCORD_RUN_ID: 'a'.repeat(32) })
  expect(input).toEqual({
    claudePid: PID,
    sessionId: SESSION,
    transcriptPath: TRANSCRIPT,
    source: 'startup',
  })
  expect(input && 'runId' in input).toBe(false)
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
  claudeStartedAt: STARTED as number | null,
  sessionId: SESSION,
  transcriptPath: TRANSCRIPT,
  now: NOW,
  newActivationId: () => NEW_ACT,
}

test('planActivation は startup で新しい activation を作る', () => {
  const plan = planActivation({ ...base, source: 'startup', existing: pointer() })
  expect(plan.isNew).toBe(true)
  expect(plan.pointer.activation_id).toBe(NEW_ACT)
  expect(plan.pointer.written_at).toBe(NOW)
})

test('planActivation は同じ session でも resume と clear と fork では新しい activation を作る', () => {
  for (const source of ['resume', 'clear', 'fork'] as const) {
    const plan = planActivation({ ...base, source, existing: pointer() })
    expect(plan.isNew).toBe(true)
    expect(plan.pointer.activation_id).toBe(NEW_ACT)
  }
})

test('planActivation は compact で同じ session なら activation を維持する', () => {
  const plan = planActivation({ ...base, source: 'compact', existing: pointer() })
  expect(plan.isNew).toBe(false)
  expect(plan.pointer.activation_id).toBe(ACT)
  expect(plan.pointer.transcript_path).toBe(TRANSCRIPT)
  expect(plan.pointer.written_at).toBe(NOW)
})

test('planActivation は compact でも session_id が違えば新しい activation を作る', () => {
  const plan = planActivation({ ...base, source: 'compact', existing: pointer({ session_id: OTHER_SESSION }) })
  expect(plan.isNew).toBe(true)
  expect(plan.pointer.activation_id).toBe(NEW_ACT)
})

test('planActivation は compact で既存ポインタが無ければ新しい activation を作る', () => {
  expect(planActivation({ ...base, source: 'compact', existing: null }).isNew).toBe(true)
})

test('planActivation は claudeStartedAt を claude_started_at に書く', () => {
  const plan = planActivation({ ...base, source: 'startup', existing: null })
  expect(plan.pointer.claude_started_at).toBe(STARTED)
})

test('planActivation は claudeStartedAt が null なら claude_started_at を書かない', () => {
  const plan = planActivation({ ...base, claudeStartedAt: null, source: 'startup', existing: null })
  expect('claude_started_at' in plan.pointer).toBe(false)
})

test('planActivation は model があればポインタに書く', () => {
  const plan = planActivation({ ...base, model: 'opus[1m]', source: 'startup', existing: null })
  expect(plan.pointer.model).toBe('opus[1m]')
})

// --- runSessionStart ---

function harness(startedAt: number | null = STARTED) {
  const asked: number[] = []
  const swept: string[] = []
  return {
    asked,
    swept,
    deps: {
      // 掃除の時点で読めるポインタの activation_id を記録する
      sweep: () => void swept.push(readPointer(PID)?.activation_id ?? 'none'),
      startedAt: (pid: number) => {
        asked.push(pid)
        return startedAt
      },
      newActivationId: () => NEW_ACT,
      now: () => NOW,
      log: () => {},
    },
  }
}

const input = { claudePid: PID, sessionId: SESSION, transcriptPath: TRANSCRIPT, source: 'startup' as const }

test('runSessionStart は自分の claude_pid の作成時刻を添えてポインタを書く', () => {
  const h = harness()
  runSessionStart(input, h.deps)
  expect(h.asked).toEqual([PID])
  expect(readPointer(PID)).toEqual({
    claude_pid: PID,
    claude_started_at: STARTED,
    session_id: SESSION,
    activation_id: NEW_ACT,
    transcript_path: TRANSCRIPT,
    source: 'startup',
    written_at: NOW,
  })
})

test('runSessionStart は作成時刻を取得できなければ claude_started_at を書かない', () => {
  const h = harness(null)
  runSessionStart(input, h.deps)
  const p = readPointer(PID)
  expect(p?.activation_id).toBe(NEW_ACT)
  expect(p && 'claude_started_at' in p).toBe(false)
})

test('runSessionStart は旧ポインタを置き換える', () => {
  writePointer(pointer())
  runSessionStart(input, harness().deps)
  expect(readPointer(PID)?.activation_id).toBe(NEW_ACT)
})

test('runSessionStart は同じ session の compact で activation_id を維持する', () => {
  writePointer(pointer())
  runSessionStart({ ...input, source: 'compact' }, harness().deps)
  expect(readPointer(PID)?.activation_id).toBe(ACT)
  expect(readPointer(PID)?.source).toBe('compact')
})

test('runSessionStart は同じ session でも clear と resume と startup で activation_id を新しくする', () => {
  for (const source of ['clear', 'resume', 'startup'] as const) {
    writePointer(pointer())
    runSessionStart({ ...input, source }, harness().deps)
    expect(readPointer(PID)?.activation_id).toBe(NEW_ACT)
  }
})

test('runSessionStart は掃除をポインタの置き換えの後に行う', () => {
  writePointer(pointer())
  const h = harness()
  runSessionStart(input, h.deps)
  expect(h.swept).toEqual([NEW_ACT])
})

test('runSessionStart はポインタを書けなくても掃除する', () => {
  const h = harness()
  // 書き込み先を壊して失敗させる (state dir を消しても作り直されるため PID を不正にする)
  runSessionStart({ ...input, claudePid: Number.NaN }, h.deps)
  expect(h.swept).toEqual(['none'])
})
