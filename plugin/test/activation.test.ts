import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  HEARTBEAT_MAX_AGE_MS,
  HEARTBEAT_TTL_MS,
  POINTER_MAX_AGE_MS,
  currentActivation,
  deleteHeartbeat,
  deletePointer,
  inspectHeartbeat,
  isFresh,
  readHeartbeat,
  readPointer,
  sessionDir,
  sweepStale,
  writeHeartbeat,
  writePointer,
  type Pointer,
} from '../src/activation'

const testTmpDir = join(tmpdir(), `discord-activation-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`)
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

const RUN = 'a'.repeat(32)
const ACT = 'b'.repeat(32)
const SESSION = '57db69e6-bf68-407b-8958-680297cb447f'

function pointer(over: Partial<Pointer> = {}): Pointer {
  return {
    claude_pid: 4321,
    run_id: RUN,
    session_id: SESSION,
    activation_id: ACT,
    transcript_path: 'C:\\transcripts\\x.jsonl',
    source: 'startup',
    written_at: Date.now(),
    ...over,
  }
}

// --- isFresh ---

test('isFresh は TTL 以内の書き込み時刻を鮮度内とする', () => {
  const now = 1_000_000
  expect(isFresh(now, 15_000, now)).toBe(true)
  expect(isFresh(now - 15_000, 15_000, now)).toBe(true)
  expect(isFresh(now - 1, 15_000, now)).toBe(true)
})

test('isFresh は TTL を超えた書き込み時刻を失効とする', () => {
  const now = 1_000_000
  expect(isFresh(now - 15_001, 15_000, now)).toBe(false)
})

test('isFresh は未来の書き込み時刻を失効とする', () => {
  const now = 1_000_000
  expect(isFresh(now + 1, 15_000, now)).toBe(false)
})

test('isFresh は数値でない値と有限でない値を失効とする', () => {
  const now = 1_000_000
  expect(isFresh('1000000', 15_000, now)).toBe(false)
  expect(isFresh(null, 15_000, now)).toBe(false)
  expect(isFresh(undefined, 15_000, now)).toBe(false)
  expect(isFresh(NaN, 15_000, now)).toBe(false)
  expect(isFresh(Infinity, 15_000, now)).toBe(false)
})

// --- writePointer / readPointer ---

test('writePointer はポインタを書き readPointer が同じ内容を返す', () => {
  const p = pointer()
  expect(writePointer(p)).toBe(true)
  expect(readPointer(4321)).toEqual(p)
})

test('writePointer は一時ファイルを残さない', () => {
  writePointer(pointer())
  expect(readdirSync(sessionDir())).toEqual(['4321.json'])
})

test('writePointer は既存のポインタを置き換える', () => {
  writePointer(pointer())
  const next = pointer({ activation_id: 'c'.repeat(32), source: 'resume' })
  expect(writePointer(next)).toBe(true)
  expect(readPointer(4321)).toEqual(next)
})

test('writePointer は run_id が無いセッションのポインタも書く', () => {
  const p = pointer({ run_id: null })
  expect(writePointer(p)).toBe(true)
  expect(readPointer(4321)).toEqual(p)
})

test('readPointer はファイルが無ければ null を返す', () => {
  expect(readPointer(4321)).toBe(null)
})

test('readPointer は解析できないファイルで null を返す', () => {
  mkdirSync(sessionDir(), { recursive: true })
  writeFileSync(join(sessionDir(), '4321.json'), '{ broken')
  expect(readPointer(4321)).toBe(null)
})

test('readPointer は必須フィールドが欠けたポインタを拒否する', () => {
  mkdirSync(sessionDir(), { recursive: true })
  const p = pointer() as Record<string, unknown>
  delete p.activation_id
  writeFileSync(join(sessionDir(), '4321.json'), JSON.stringify(p))
  expect(readPointer(4321)).toBe(null)
})

test('readPointer は識別子の形式が不正なポインタを拒否する', () => {
  mkdirSync(sessionDir(), { recursive: true })
  for (const bad of [
    { session_id: 'not-a-uuid' },
    { activation_id: 'zz' },
    { run_id: 'zz' },
    { source: 'unknown' },
    { written_at: 'now' },
  ]) {
    writeFileSync(join(sessionDir(), '4321.json'), JSON.stringify({ ...pointer(), ...bad }))
    expect(readPointer(4321)).toBe(null)
  }
})

test('readPointer はファイル名と内容の claude_pid が食い違うポインタを拒否する', () => {
  mkdirSync(sessionDir(), { recursive: true })
  writeFileSync(join(sessionDir(), '4321.json'), JSON.stringify(pointer({ claude_pid: 9999 })))
  expect(readPointer(4321)).toBe(null)
})

test('readPointer は不正な PID では読まない', () => {
  expect(readPointer(NaN)).toBe(null)
  expect(readPointer(-1)).toBe(null)
})

// --- deletePointer ---

test('deletePointer はポインタを削除して true を返す', () => {
  writePointer(pointer())
  expect(deletePointer(4321)).toBe(true)
  expect(readPointer(4321)).toBe(null)
})

test('deletePointer はポインタが無くても true を返す', () => {
  expect(deletePointer(4321)).toBe(true)
})

// --- heartbeat ---

test('writeHeartbeat は run_id と時刻を書き readHeartbeat が読む', () => {
  const now = Date.now()
  expect(writeHeartbeat(4321, RUN, now)).toBe(true)
  expect(readHeartbeat(4321, RUN)).toEqual({ run_id: RUN, written_at: now })
})

test('writeHeartbeat は run ごとに別のファイルへ書く', () => {
  const other = 'c'.repeat(32)
  writeHeartbeat(4321, RUN, 1)
  writeHeartbeat(4321, other, 2)
  expect(readHeartbeat(4321, RUN)?.written_at).toBe(1)
  expect(readHeartbeat(4321, other)?.written_at).toBe(2)
})

test('readHeartbeat は内容の run_id が要求と違えば null を返す', () => {
  mkdirSync(sessionDir(), { recursive: true })
  writeFileSync(join(sessionDir(), `4321.${RUN}.heartbeat`), JSON.stringify({ run_id: 'c'.repeat(32), written_at: 1 }))
  expect(readHeartbeat(4321, RUN)).toBe(null)
})

test('readHeartbeat はファイルが無ければ null を返す', () => {
  expect(readHeartbeat(4321, RUN)).toBe(null)
})

test('readHeartbeat は解析できないファイルで null を返す', () => {
  mkdirSync(sessionDir(), { recursive: true })
  writeFileSync(join(sessionDir(), `4321.${RUN}.heartbeat`), 'broken')
  expect(readHeartbeat(4321, RUN)).toBe(null)
})

test('readHeartbeat は不正な run_id では読まない', () => {
  expect(readHeartbeat(4321, '../evil')).toBe(null)
})

test('deleteHeartbeat は自分の run の heartbeat だけを削除する', () => {
  writeHeartbeat(4321, RUN, Date.now())
  expect(deleteHeartbeat(4321, RUN)).toBe(true)
  expect(existsSync(join(sessionDir(), `4321.${RUN}.heartbeat`))).toBe(false)
})

test('deleteHeartbeat は内容の run_id が自分と違えば削除しない', () => {
  mkdirSync(sessionDir(), { recursive: true })
  const f = join(sessionDir(), `4321.${RUN}.heartbeat`)
  writeFileSync(f, JSON.stringify({ run_id: 'c'.repeat(32), written_at: 1 }))
  expect(deleteHeartbeat(4321, RUN)).toBe(false)
  expect(readFileSync(f, 'utf8')).toContain('c'.repeat(32))
})

test('HEARTBEAT_TTL_MS は 15 秒である', () => {
  expect(HEARTBEAT_TTL_MS).toBe(15_000)
})

// --- inspectHeartbeat ---

test('inspectHeartbeat は不在と鮮度内と失効を区別する', () => {
  const now = 1_000_000
  expect(inspectHeartbeat(4321, RUN, now)).toEqual({ state: 'missing' })
  writeHeartbeat(4321, RUN, now - 1_000)
  expect(inspectHeartbeat(4321, RUN, now)).toEqual({ state: 'fresh' })
  writeHeartbeat(4321, RUN, now - HEARTBEAT_TTL_MS - 1)
  expect(inspectHeartbeat(4321, RUN, now)).toEqual({ state: 'expired' })
})

test('inspectHeartbeat は解析できない heartbeat を error として扱う', () => {
  mkdirSync(sessionDir(), { recursive: true })
  writeFileSync(join(sessionDir(), `4321.${RUN}.heartbeat`), 'broken')
  expect(inspectHeartbeat(4321, RUN, 1_000_000)).toEqual({ state: 'error' })
})

test('inspectHeartbeat は run_id が食い違う heartbeat を error として扱う', () => {
  mkdirSync(sessionDir(), { recursive: true })
  writeFileSync(join(sessionDir(), `4321.${RUN}.heartbeat`), JSON.stringify({ run_id: 'c'.repeat(32), written_at: 1 }))
  expect(inspectHeartbeat(4321, RUN, 1_000_000)).toEqual({ state: 'error' })
})

// --- currentActivation ---

test('currentActivation は run_id が一致するポインタを現行として返す', () => {
  const p = pointer()
  writePointer(p)
  expect(currentActivation(4321, RUN)).toEqual(p)
})

test('currentActivation は run_id が一致しなければ null を返す', () => {
  writePointer(pointer())
  expect(currentActivation(4321, 'c'.repeat(32))).toBe(null)
})

test('currentActivation は run_id を持たない呼び出しでは null を返す', () => {
  writePointer(pointer({ run_id: null }))
  expect(currentActivation(4321, null)).toBe(null)
})

test('currentActivation はポインタが無ければ null を返す', () => {
  expect(currentActivation(4321, RUN)).toBe(null)
})

// --- sweepStale ---

const DAY = 24 * 60 * 60 * 1000

test('sweepStale は 7 日より古く heartbeat の無いポインタを削除する', () => {
  const now = 100 * DAY
  writePointer(pointer({ claude_pid: 1111, written_at: now - POINTER_MAX_AGE_MS - 1 }))
  const result = sweepStale(4321, now)
  expect(result.removed).toEqual(['1111.json'])
  expect(readPointer(1111)).toBe(null)
})

test('sweepStale は 7 日より古くても heartbeat が鮮度内のポインタを保持する', () => {
  const now = 100 * DAY
  writePointer(pointer({ claude_pid: 1111, written_at: now - POINTER_MAX_AGE_MS - 1 }))
  writeHeartbeat(1111, RUN, now - 1_000)
  const result = sweepStale(4321, now)
  expect(result.removed).toEqual([])
  expect(readPointer(1111)).not.toBe(null)
})

test('sweepStale は 7 日以内のポインタを保持する', () => {
  const now = 100 * DAY
  writePointer(pointer({ claude_pid: 1111, written_at: now - POINTER_MAX_AGE_MS + 1 }))
  expect(sweepStale(4321, now).removed).toEqual([])
  expect(readPointer(1111)).not.toBe(null)
})

test('sweepStale は自分の claude_pid のポインタを対象にしない', () => {
  const now = 100 * DAY
  writePointer(pointer({ claude_pid: 4321, written_at: now - POINTER_MAX_AGE_MS - 1 }))
  expect(sweepStale(4321, now).removed).toEqual([])
  expect(readPointer(4321)).not.toBe(null)
})

test('sweepStale は heartbeat を読めないポインタを保持する', () => {
  const now = 100 * DAY
  writePointer(pointer({ claude_pid: 1111, written_at: now - POINTER_MAX_AGE_MS - 1 }))
  mkdirSync(sessionDir(), { recursive: true })
  writeFileSync(join(sessionDir(), `1111.${RUN}.heartbeat`), 'broken')
  const result = sweepStale(4321, now)
  expect(result.removed).toEqual([])
  expect(result.kept).toContain('1111.json')
})

test('sweepStale は 1 時間より古い heartbeat を削除する', () => {
  const now = 100 * DAY
  writeHeartbeat(1111, RUN, now - HEARTBEAT_MAX_AGE_MS - 1)
  expect(sweepStale(4321, now).removed).toEqual([`1111.${RUN}.heartbeat`])
  expect(readHeartbeat(1111, RUN)).toBe(null)
})

test('sweepStale は 1 時間以内の heartbeat を保持する', () => {
  const now = 100 * DAY
  writeHeartbeat(1111, RUN, now - HEARTBEAT_MAX_AGE_MS + 1)
  expect(sweepStale(4321, now).removed).toEqual([])
  expect(readHeartbeat(1111, RUN)).not.toBe(null)
})

test('sweepStale は解析できない heartbeat を保持する', () => {
  const now = 100 * DAY
  mkdirSync(sessionDir(), { recursive: true })
  writeFileSync(join(sessionDir(), `1111.${RUN}.heartbeat`), 'broken')
  expect(sweepStale(4321, now).removed).toEqual([])
  expect(existsSync(join(sessionDir(), `1111.${RUN}.heartbeat`))).toBe(true)
})

test('sweepStale は規約外の名前のファイルを触らない', () => {
  const now = 100 * DAY
  mkdirSync(sessionDir(), { recursive: true })
  writeFileSync(join(sessionDir(), 'notes.txt'), 'x')
  expect(sweepStale(4321, now).removed).toEqual([])
  expect(existsSync(join(sessionDir(), 'notes.txt'))).toBe(true)
})

test('sweepStale はディレクトリが無くても失敗しない', () => {
  expect(sweepStale(4321, 100 * DAY)).toEqual({ removed: [], kept: [] })
})
