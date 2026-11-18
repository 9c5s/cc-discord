import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { deletePointer, readPointer, sessionDir, sweepStale, writePointer, type Pointer } from '../src/activation'
import { lookupProcess, type ProcessLookup } from '../src/process-tree'

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
const STARTED = 1_700_000_000_000
const WRITTEN = 1_700_000_100_000

function pointer(over: Partial<Pointer> = {}): Pointer {
  return {
    claude_pid: 4321,
    claude_started_at: STARTED,
    session_id: SESSION,
    activation_id: ACT,
    transcript_path: 'C:\\transcripts\\x.jsonl',
    source: 'startup',
    written_at: WRITTEN,
    ...over,
  }
}

// run_id を持ち claude_started_at を持たない旧形式のポインタを書く
function writeLegacyPointer(pid: number, writtenAt: number): void {
  mkdirSync(sessionDir(), { recursive: true })
  writeFileSync(
    join(sessionDir(), `${pid}.json`),
    JSON.stringify({
      claude_pid: pid,
      run_id: RUN,
      session_id: SESSION,
      activation_id: ACT,
      transcript_path: 'C:\\transcripts\\x.jsonl',
      source: 'startup',
      written_at: writtenAt,
    }),
  )
}

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

test('writePointer は claude_started_at を持たないポインタも書く', () => {
  const p = pointer()
  delete p.claude_started_at
  expect(writePointer(p)).toBe(true)
  const read = readPointer(4321)
  expect(read).toEqual(p)
  expect(read && 'claude_started_at' in read).toBe(false)
})

test('readPointer は run_id を持つ旧形式のポインタも読み run_id を取り込まない', () => {
  writeLegacyPointer(4321, WRITTEN)
  const read = readPointer(4321)
  expect(read).toEqual({
    claude_pid: 4321,
    session_id: SESSION,
    activation_id: ACT,
    transcript_path: 'C:\\transcripts\\x.jsonl',
    source: 'startup',
    written_at: WRITTEN,
  })
  expect(read && 'run_id' in read).toBe(false)
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
    { source: 'unknown' },
    { written_at: 'now' },
    { claude_started_at: 'then' },
    { claude_started_at: null },
  ]) {
    writeFileSync(join(sessionDir(), '4321.json'), JSON.stringify({ ...pointer(), ...bad }))
    expect(readPointer(4321)).toBe(null)
  }
})

test('readPointer はファイル名と内容の claude_pid が一致しないポインタを拒否する', () => {
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

// --- sweepStale ---

const found = (startMs: number): ProcessLookup => ({ kind: 'found', info: { pid: 1111, ppid: 1, startMs, argv: null } })

// PID ごとの照会結果を返し 照会された PID を記録する偽の lookup (表に無い PID は error)
function fakeLookup(table: Record<number, ProcessLookup>) {
  const asked: number[] = []
  const lookup = (pid: number): ProcessLookup => {
    asked.push(pid)
    return table[pid] ?? { kind: 'error' }
  }
  return { lookup, asked }
}

test('sweepStale はプロセスが存在しない PID のポインタを消す', () => {
  writePointer(pointer({ claude_pid: 1111 }))
  const result = sweepStale(4321, fakeLookup({ 1111: { kind: 'missing' } }).lookup)
  expect(result.removed).toEqual(['1111.json'])
  expect(readPointer(1111)).toBe(null)
})

test('sweepStale は作成時刻が claude_started_at と違う PID のポインタを消す', () => {
  writePointer(pointer({ claude_pid: 1111 }))
  const result = sweepStale(4321, fakeLookup({ 1111: found(STARTED + 1) }).lookup)
  expect(result.removed).toEqual(['1111.json'])
  expect(readPointer(1111)).toBe(null)
})

test('sweepStale は作成時刻が claude_started_at と一致する PID のポインタを残す', () => {
  writePointer(pointer({ claude_pid: 1111 }))
  const result = sweepStale(4321, fakeLookup({ 1111: found(STARTED) }).lookup)
  expect(result).toEqual({ removed: [], kept: ['1111.json'] })
  expect(readPointer(1111)).not.toBe(null)
})

test('sweepStale は claude_started_at を持たない旧形式を作成時刻が written_at より後なら消す', () => {
  writeLegacyPointer(1111, WRITTEN)
  const result = sweepStale(4321, fakeLookup({ 1111: found(WRITTEN + 1) }).lookup)
  expect(result.removed).toEqual(['1111.json'])
  expect(readPointer(1111)).toBe(null)
})

test('sweepStale は claude_started_at を持たない旧形式を作成時刻が written_at より前なら残す', () => {
  writeLegacyPointer(1111, WRITTEN)
  const result = sweepStale(4321, fakeLookup({ 1111: found(WRITTEN - 1) }).lookup)
  expect(result).toEqual({ removed: [], kept: ['1111.json'] })
  expect(readPointer(1111)).not.toBe(null)
})

test('sweepStale はプロセスの情報を取得できなかった PID のポインタを残す', () => {
  writePointer(pointer({ claude_pid: 1111 }))
  const result = sweepStale(4321, fakeLookup({ 1111: { kind: 'error' } }).lookup)
  expect(result).toEqual({ removed: [], kept: ['1111.json'] })
  expect(readPointer(1111)).not.toBe(null)
})

test('sweepStale は自分の claude_pid のポインタを照会せずに残す', () => {
  writePointer(pointer({ claude_pid: 4321 }))
  const f = fakeLookup({ 4321: { kind: 'missing' } })
  const result = sweepStale(4321, f.lookup)
  expect(result).toEqual({ removed: [], kept: ['4321.json'] })
  expect(f.asked).toEqual([])
  expect(readPointer(4321)).not.toBe(null)
})

test('sweepStale は存在するプロセスの解析できないポインタを残す', () => {
  mkdirSync(sessionDir(), { recursive: true })
  writeFileSync(join(sessionDir(), '1111.json'), '{ broken')
  const result = sweepStale(4321, fakeLookup({ 1111: found(STARTED) }).lookup)
  expect(result).toEqual({ removed: [], kept: ['1111.json'] })
})

test('sweepStale は heartbeat のファイルを消す', () => {
  mkdirSync(sessionDir(), { recursive: true })
  const name = `1111.${RUN}.heartbeat`
  writeFileSync(join(sessionDir(), name), JSON.stringify({ run_id: RUN, written_at: WRITTEN }))
  const result = sweepStale(4321, fakeLookup({}).lookup)
  expect(result.removed).toEqual([name])
  expect(existsSync(join(sessionDir(), name))).toBe(false)
})

test('sweepStale は規約外の名前のファイルを触らない', () => {
  mkdirSync(sessionDir(), { recursive: true })
  writeFileSync(join(sessionDir(), 'notes.txt'), 'x')
  const f = fakeLookup({})
  expect(sweepStale(4321, f.lookup)).toEqual({ removed: [], kept: [] })
  expect(f.asked).toEqual([])
  expect(existsSync(join(sessionDir(), 'notes.txt'))).toBe(true)
})

test('sweepStale はディレクトリが無くても失敗しない', () => {
  expect(sweepStale(4321, fakeLookup({}).lookup)).toEqual({ removed: [], kept: [] })
})

test('sweepStale は lookup を省略すると実際のプロセスを照会する', () => {
  const self = lookupProcess(process.pid)
  if (self.kind !== 'found') throw new Error('lookupProcess(process.pid) must succeed')
  const otherSelf = process.pid + 1
  writePointer(pointer({ claude_pid: process.pid, claude_started_at: self.info.startMs }))
  expect(sweepStale(otherSelf).kept).toEqual([`${process.pid}.json`])

  writePointer(pointer({ claude_pid: process.pid, claude_started_at: self.info.startMs - 1 }))
  expect(sweepStale(otherSelf).removed).toEqual([`${process.pid}.json`])
})
