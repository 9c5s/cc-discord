import { test, expect, beforeEach, afterEach } from 'bun:test'
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createWatcher, parseWatchArgs } from '../src/watch'
import { writeHeartbeat, writePointer, type Pointer } from '../src/activation'
import type { SendOutcome } from '../src/progress-sender'

const testTmpDir = join(tmpdir(), `discord-watcher-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`)
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
const SESSION = '57db69e6-bf68-407b-8958-680297cb447f'
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

const ASSISTANT = (text: string): string =>
  `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })}\n`

// --- parseWatchArgs ---

const validArgs = ['C:\\t.jsonl', SESSION, String(PID), RUN, ACT]

test('parseWatchArgs は 5 つの引数を受け取る', () => {
  expect(parseWatchArgs(validArgs)).toEqual({
    transcriptPath: 'C:\\t.jsonl',
    sessionId: SESSION,
    claudePid: PID,
    runId: RUN,
    activationId: ACT,
  })
})

test('parseWatchArgs は引数が足りなければ null を返す', () => {
  expect(parseWatchArgs(validArgs.slice(0, 4))).toBe(null)
  expect(parseWatchArgs([])).toBe(null)
})

test('parseWatchArgs は形式が不正な識別子を拒否する', () => {
  expect(parseWatchArgs(['C:\\t.jsonl', 'not-uuid', String(PID), RUN, ACT])).toBe(null)
  expect(parseWatchArgs(['C:\\t.jsonl', SESSION, 'abc', RUN, ACT])).toBe(null)
  expect(parseWatchArgs(['C:\\t.jsonl', SESSION, String(PID), 'zz', ACT])).toBe(null)
  expect(parseWatchArgs(['C:\\t.jsonl', SESSION, String(PID), RUN, 'zz'])).toBe(null)
  expect(parseWatchArgs(['', SESSION, String(PID), RUN, ACT])).toBe(null)
})

// --- createWatcher ---

function watcher(over: Record<string, unknown> = {}) {
  const transcriptPath = join(testTmpDir, 'transcript.jsonl')
  if (!(over.skipCreate as boolean)) writeFileSync(transcriptPath, '')
  const sent: string[] = []
  let now = NOW
  const outcome = (over.outcome as SendOutcome) ?? 'sent'
  const w = createWatcher({
    transcriptPath,
    claudePid: PID,
    runId: RUN,
    activationId: ACT,
    send: async (text: string) => {
      sent.push(text)
      return outcome
    },
    now: () => now,
  })
  return { w, sent, transcriptPath, advance: (ms: number) => void (now += ms) }
}

test('createWatcher は heartbeat を待つ状態から始まる', () => {
  const { w } = watcher()
  expect(w.state()).toBe('WAIT_HEARTBEAT')
})

test('createWatcher は有効な heartbeat を確認したら監視を始める', () => {
  writeHeartbeat(PID, RUN, NOW)
  writePointer(pointer())
  const { w } = watcher()
  w.tick()
  expect(w.state()).toBe('ACTIVE')
})

test('createWatcher は 30 秒待っても heartbeat が無ければ終了する', () => {
  const { w, advance } = watcher()
  w.tick()
  expect(w.state()).toBe('WAIT_HEARTBEAT')
  advance(30_001)
  w.tick()
  expect(w.state()).toBe('TERMINATED')
})

test('createWatcher は待機中に transcript を読まない', async () => {
  const v = watcher()
  appendFileSync(v.transcriptPath, ASSISTANT('待機中の追記'))
  await v.w.poll()
  expect(v.sent).toEqual([])
})

test('createWatcher は待機中の追記を ACTIVE 移行後に順番に投稿する', async () => {
  const v = watcher()
  appendFileSync(v.transcriptPath, ASSISTANT('1 番目'))
  await v.w.poll()
  writeHeartbeat(PID, RUN, NOW)
  writePointer(pointer())
  v.w.tick()
  appendFileSync(v.transcriptPath, ASSISTANT('2 番目'))
  await v.w.poll()
  expect(v.sent).toEqual(['💬 1 番目\n💬 2 番目'])
})

test('createWatcher は起動前の内容を投稿しない', async () => {
  const transcriptPath = join(testTmpDir, 'transcript.jsonl')
  mkdirSync(testTmpDir, { recursive: true })
  writeFileSync(transcriptPath, ASSISTANT('起動前'))
  writeHeartbeat(PID, RUN, NOW)
  writePointer(pointer())
  const v = watcher({ skipCreate: true })
  v.w.tick()
  await v.w.poll()
  expect(v.sent).toEqual([])
})

test('createWatcher は heartbeat が失効している間 transcript を読み進めない', async () => {
  // 読み取り位置だけ進めると 送信側が同じ理由で諦めた分を取り戻せない
  writeHeartbeat(PID, RUN, NOW)
  writePointer(pointer())
  const v = watcher()
  v.w.tick()

  v.advance(15_001)
  appendFileSync(v.transcriptPath, ASSISTANT('復帰待ちの追記'))
  await v.w.poll()
  expect(v.sent).toEqual([])

  writeHeartbeat(PID, RUN, NOW + 15_001)
  await v.w.poll()
  expect(v.sent).toHaveLength(1)
  expect(v.sent[0]).toContain('復帰待ちの追記')
})

test('createWatcher は heartbeat が失効したら待機へ戻る', () => {
  // サスペンドからの復帰直後と MCP だけの再起動では proxy の書き直しが tick より遅れる
  writeHeartbeat(PID, RUN, NOW)
  writePointer(pointer())
  const { w, advance } = watcher()
  w.tick()
  advance(15_001)
  w.tick()
  expect(w.state()).toBe('WAIT_HEARTBEAT')
})

test('createWatcher は待機へ戻った後に heartbeat が書き直されたら監視を続ける', () => {
  writeHeartbeat(PID, RUN, NOW)
  writePointer(pointer())
  const { w, advance } = watcher()
  w.tick()
  advance(15_001)
  w.tick()
  writeHeartbeat(PID, RUN, NOW + 15_001)
  w.tick()
  expect(w.state()).toBe('ACTIVE')
})

test('createWatcher は待機へ戻ってから 30 秒 heartbeat が来なければ終了する', () => {
  writeHeartbeat(PID, RUN, NOW)
  writePointer(pointer())
  const { w, advance } = watcher()
  w.tick()
  advance(15_001)
  w.tick()
  advance(30_001)
  w.tick()
  expect(w.state()).toBe('TERMINATED')
})

test('createWatcher は heartbeat の run_id が違えば監視を続けない', () => {
  writeHeartbeat(PID, RUN, NOW)
  writePointer(pointer())
  const { w } = watcher()
  w.tick()
  writeHeartbeat(PID, 'c'.repeat(32), NOW)
  rmSync(join(process.env.DISCORD_STATE_DIR as string, 'session', 'by-pid', `${PID}.${RUN}.heartbeat`), { force: true })
  w.tick()
  expect(w.state()).toBe('WAIT_HEARTBEAT')
})

test('createWatcher はポインタの activation が変わったら終了する', () => {
  writeHeartbeat(PID, RUN, NOW)
  writePointer(pointer())
  const { w } = watcher()
  w.tick()
  writePointer(pointer({ activation_id: 'c'.repeat(32) }))
  w.tick()
  expect(w.state()).toBe('TERMINATED')
})

test('createWatcher はポインタが消えたら終了する', () => {
  writeHeartbeat(PID, RUN, NOW)
  writePointer(pointer())
  const { w } = watcher()
  w.tick()
  rmSync(join(process.env.DISCORD_STATE_DIR as string, 'session', 'by-pid', `${PID}.json`), { force: true })
  w.tick()
  expect(w.state()).toBe('TERMINATED')
})

test('createWatcher は送信側が終了を返したら終了する', async () => {
  writeHeartbeat(PID, RUN, NOW)
  writePointer(pointer())
  const v = watcher({ outcome: 'terminated' })
  v.w.tick()
  appendFileSync(v.transcriptPath, ASSISTANT('進捗'))
  await v.w.poll()
  expect(v.w.state()).toBe('TERMINATED')
})

test('createWatcher は終了後に投稿しない', async () => {
  writeHeartbeat(PID, RUN, NOW)
  writePointer(pointer())
  const v = watcher()
  v.w.tick()
  writePointer(pointer({ activation_id: 'c'.repeat(32) }))
  v.w.tick()
  appendFileSync(v.transcriptPath, ASSISTANT('進捗'))
  await v.w.poll()
  expect(v.sent).toEqual([])
})

test('createWatcher は transcript が縮んだら読み直す', async () => {
  writeHeartbeat(PID, RUN, NOW)
  writePointer(pointer())
  const v = watcher()
  v.w.tick()
  appendFileSync(v.transcriptPath, ASSISTANT('1') + ASSISTANT('2'))
  await v.w.poll()
  // 上書きでファイルが短くなった場合は読み取り位置を先頭へ戻す
  writeFileSync(v.transcriptPath, ASSISTANT('3'))
  await v.w.poll()
  expect(v.sent).toEqual(['💬 1\n💬 2', '💬 3'])
})

test('createWatcher は transcript が無くても失敗しない', async () => {
  writeHeartbeat(PID, RUN, NOW)
  writePointer(pointer())
  const v = watcher({ skipCreate: true })
  v.w.tick()
  await v.w.poll()
  expect(v.sent).toEqual([])
})
