import { test, expect, afterEach } from 'bun:test'
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Pointer } from '../src/activation'
import type { TailReader } from '../src/watch'
import {
  createProgressForwarder,
  MAX_RETRY_WAIT_MS,
  TARGET_TTL_MS,
  type ProgressTarget,
  type SendResult,
} from '../src/progress'

const testTmpDir = join(tmpdir(), `discord-progress-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`)

afterEach(() => {
  rmSync(testTmpDir, { recursive: true, force: true })
})

const ACT_A = 'a'.repeat(32)
const ACT_B = 'b'.repeat(32)
const SESSION = '57db69e6-bf68-407b-8958-680297cb447f'
const CH = '33333333333333333'
const THREAD = '44444444444444444'
const THREAD_2 = '55555555555555555'
const NOW = 1_800_000_000_000

// 中身の無い transcript を作ってパスを返す
function emptyTranscript(name: string): string {
  mkdirSync(testTmpDir, { recursive: true })
  const p = join(testTmpDir, name)
  writeFileSync(p, '')
  return p
}

function pointer(activationId: string, transcriptPath: string): Pointer {
  return {
    claude_pid: 4321,
    claude_started_at: NOW - 60_000,
    session_id: SESSION,
    activation_id: activationId,
    transcript_path: transcriptPath,
    source: 'startup',
    written_at: NOW,
  }
}

function target(over: Partial<ProgressTarget> = {}): ProgressTarget {
  return { id: THREAD, parentId: CH, kind: 'guild', activationId: ACT_A, setAt: NOW, ...over }
}

// assistant の text ブロックを並べた transcript の 1 行
function textLine(...texts: string[]): string {
  return JSON.stringify({ type: 'assistant', message: { content: texts.map((text) => ({ type: 'text', text })) } }) + '\n'
}

type Overrides = {
  canSend?: (t: ProgressTarget) => boolean
  send?: (targetId: string, text: string) => Promise<SendResult>
  sleep?: (ms: number) => Promise<void>
  openReader?: (path: string) => TailReader
}

function setup(over: Overrides = {}) {
  const env = {
    pointer: null as Pointer | null,
    clock: NOW,
    sent: [] as Array<[string, string]>,
    logs: [] as string[],
  }
  const fw = createProgressForwarder({
    activation: () => env.pointer,
    canSend: over.canSend ?? (() => true),
    send: (targetId, text) => {
      env.sent.push([targetId, text])
      return over.send ? over.send(targetId, text) : Promise.resolve({ ok: true })
    },
    sleep: over.sleep ?? (() => Promise.resolve()),
    now: () => env.clock,
    log: (m) => env.logs.push(m),
    ...(over.openReader ? { openReader: over.openReader } : {}),
  })
  return { env, fw }
}

// activation A の transcript を追い 宛先を設定した状態を作る
function setupWithTarget(over: Overrides = {}) {
  const a = emptyTranscript('a.jsonl')
  const { env, fw } = setup(over)
  env.pointer = pointer(ACT_A, a)
  fw.tick()
  fw.setTarget(target())
  return { env, fw, a }
}

test('宛先を設定する前の行は送らない', async () => {
  const a = emptyTranscript('a.jsonl')
  const { env, fw } = setup()
  env.pointer = pointer(ACT_A, a)
  fw.tick()
  appendFileSync(a, textLine('before'))
  await fw.poll()
  fw.setTarget(target())
  await fw.poll()
  appendFileSync(a, textLine('after'))
  await fw.poll()
  expect(env.sent).toEqual([[THREAD, '💬 after']])
})

test('宛先の設定後に追記された text を 💬 付きで宛先へ送る', async () => {
  const { env, fw, a } = setupWithTarget()
  appendFileSync(a, textLine('hello'))
  await fw.poll()
  expect(env.sent).toEqual([[THREAD, '💬 hello']])
})

test('activation が変わると宛先を消し 新しい transcript の末尾から読む', async () => {
  const { env, fw, a } = setupWithTarget()
  const b = emptyTranscript('b.jsonl')
  appendFileSync(b, textLine('old in b'))
  env.pointer = pointer(ACT_B, b)
  fw.tick()
  expect(fw.currentTargetId()).toBeNull()
  fw.setTarget(target({ id: THREAD_2, activationId: ACT_B }))
  appendFileSync(a, textLine('late in a'))
  appendFileSync(b, textLine('new in b'))
  await fw.poll()
  expect(env.sent).toEqual([[THREAD_2, '💬 new in b']])
})

test('新しい transcript がまだ無くても止まらず 作られた後の行を読む', async () => {
  const { env, fw } = setupWithTarget()
  const b = join(testTmpDir, 'b.jsonl')
  env.pointer = pointer(ACT_B, b)
  fw.tick()
  await expect(fw.poll()).resolves.toBeUndefined()
  writeFileSync(b, textLine('first'))
  fw.setTarget(target({ activationId: ACT_B }))
  await fw.poll()
  expect(env.sent).toEqual([[THREAD, '💬 first']])
})

test('transcript_path だけが変わったら宛先を保ったまま新しいファイルを読む', async () => {
  const { env, fw, a } = setupWithTarget()
  const b = emptyTranscript('b.jsonl')
  env.pointer = pointer(ACT_A, b)
  fw.tick()
  expect(fw.currentTargetId()).toBe(THREAD)
  appendFileSync(a, textLine('stale'))
  appendFileSync(b, textLine('moved'))
  await fw.poll()
  expect(env.sent).toEqual([[THREAD, '💬 moved']])
})

test('12 時間を過ぎた宛先へは送らない', async () => {
  const { env, fw, a } = setupWithTarget()
  env.clock = NOW + TARGET_TTL_MS
  appendFileSync(a, textLine('at the limit'))
  await fw.poll()
  env.clock = NOW + TARGET_TTL_MS + 1
  appendFileSync(a, textLine('expired'))
  await fw.poll()
  expect(env.sent).toEqual([[THREAD, '💬 at the limit']])
  expect(fw.currentTargetId()).toBeNull()
})

test('canSend が false なら送らない', async () => {
  const checked: string[] = []
  const { env, fw, a } = setupWithTarget({
    canSend: (t) => {
      checked.push(t.id)
      return false
    },
  })
  appendFileSync(a, textLine('hello'))
  await fw.poll()
  expect(checked).toEqual([THREAD])
  expect(env.sent).toEqual([])
})

test('send が失敗しても次の poll で後続の行を送る', async () => {
  let calls = 0
  const { env, fw, a } = setupWithTarget({
    send: () => Promise.resolve(calls++ === 0 ? { ok: false } : { ok: true }),
  })
  appendFileSync(a, textLine('first'))
  await fw.poll()
  appendFileSync(a, textLine('second'))
  await fw.poll()
  expect(env.sent).toEqual([[THREAD, '💬 first'], [THREAD, '💬 second']])
})

test('send が例外を投げたらログに残して次のチャンクを送る', async () => {
  let calls = 0
  const { env, fw, a } = setupWithTarget({
    send: () => (calls++ === 0 ? Promise.reject(new Error('socket hang up')) : Promise.resolve({ ok: true })),
  })
  appendFileSync(a, textLine('x'.repeat(1000), 'y'.repeat(1000)))
  await expect(fw.poll()).resolves.toBeUndefined()
  expect(env.sent).toEqual([[THREAD, '💬 ' + 'x'.repeat(1000)], [THREAD, '💬 ' + 'y'.repeat(1000)]])
  expect(env.logs.some((m) => m.includes('socket hang up'))).toBe(true)
})

test('activation の違う宛先の設定は受け付けない', async () => {
  const a = emptyTranscript('a.jsonl')
  const { env, fw } = setup()
  env.pointer = pointer(ACT_A, a)
  fw.tick()
  fw.setTarget(target({ activationId: ACT_B }))
  expect(fw.currentTargetId()).toBeNull()
  appendFileSync(a, textLine('hello'))
  await fw.poll()
  expect(env.sent).toEqual([])
})

test('activation が読めなくなったら宛先を消す', async () => {
  const { env, fw, a } = setupWithTarget()
  env.pointer = null
  fw.tick()
  expect(fw.currentTargetId()).toBeNull()
  env.pointer = pointer(ACT_A, a)
  fw.tick()
  appendFileSync(a, textLine('hello'))
  await fw.poll()
  expect(fw.currentTargetId()).toBeNull()
  expect(env.sent).toEqual([])
})

test('1900 コードポイントを超える投稿は 1900 で切る', async () => {
  const { env, fw, a } = setupWithTarget()
  // サロゲートペアの文字で UTF-16 の長さではなくコードポイントで数えることを確かめる
  const name = '𠮷'.repeat(2000)
  const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name, input: {} }] } })
  appendFileSync(a, line + '\n')
  await fw.poll()
  expect(env.sent).toEqual([[THREAD, [...`\`⚙️[${name}]\``].slice(0, 1900).join('')]])
  expect([...env.sent[0][1]]).toHaveLength(1900)
})

test('1 チャンク目の送信を待つ間に宛先が差し替わったら 残りのチャンクを捨てる', async () => {
  let release!: () => void
  const pending = new Promise<SendResult>((r) => {
    release = () => r({ ok: true })
  })
  let calls = 0
  const { env, fw, a } = setupWithTarget({
    send: () => (calls++ === 0 ? pending : Promise.resolve({ ok: true })),
  })
  appendFileSync(a, textLine('x'.repeat(1000), 'y'.repeat(1000)))
  const polling = fw.poll()
  expect(env.sent).toHaveLength(1)
  fw.setTarget(target({ id: THREAD_2, setAt: NOW + 1 }))
  release()
  await polling
  expect(env.sent).toEqual([[THREAD, '💬 ' + 'x'.repeat(1000)]])
})

test('1 チャンク目の送信を待つ間に同じ宛先のオブジェクトを設定し直しても 残りのチャンクを捨てる', async () => {
  let release!: () => void
  const pending = new Promise<SendResult>((r) => {
    release = () => r({ ok: true })
  })
  let calls = 0
  const a = emptyTranscript('a.jsonl')
  const { env, fw } = setup({
    send: () => (calls++ === 0 ? pending : Promise.resolve({ ok: true })),
  })
  env.pointer = pointer(ACT_A, a)
  fw.tick()
  const t = target()
  fw.setTarget(t)
  appendFileSync(a, textLine('x'.repeat(1000), 'y'.repeat(1000)))
  const polling = fw.poll()
  fw.setTarget(t)
  release()
  await polling
  expect(env.sent).toEqual([[THREAD, '💬 ' + 'x'.repeat(1000)]])
})

test('poll は前回の呼び出しが終わるまで次を始めない', async () => {
  let release!: () => void
  const pending = new Promise<SendResult>((r) => {
    release = () => r({ ok: true })
  })
  let calls = 0
  const { env, fw, a } = setupWithTarget({
    send: () => (calls++ === 0 ? pending : Promise.resolve({ ok: true })),
  })
  appendFileSync(a, textLine('first'))
  const polling = fw.poll()
  appendFileSync(a, textLine('second'))
  await fw.poll()
  expect(env.sent).toEqual([[THREAD, '💬 first']])
  release()
  await polling
  await fw.poll()
  expect(env.sent).toEqual([[THREAD, '💬 first'], [THREAD, '💬 second']])
})

test('429 の待ちが 10 秒以内なら待ってから確かめ直して 1 回だけ送り直す', async () => {
  const events: string[] = []
  const { env, fw, a } = setupWithTarget({
    canSend: () => {
      events.push('canSend')
      return true
    },
    send: () => {
      events.push('send')
      return Promise.resolve({ ok: false, retryAfterMs: 3000 })
    },
    sleep: (ms) => {
      events.push(`sleep ${ms}`)
      return Promise.resolve()
    },
  })
  events.length = 0
  appendFileSync(a, textLine('hello'))
  await fw.poll()
  expect(events).toEqual(['canSend', 'send', 'sleep 3000', 'canSend', 'send'])
  expect(env.sent).toEqual([[THREAD, '💬 hello'], [THREAD, '💬 hello']])
})

test('429 の待ちの間に activation が変わったら送り直さない', async () => {
  const b = emptyTranscript('b.jsonl')
  let switchActivation = (): void => {}
  const { env, fw, a } = setupWithTarget({
    send: () => Promise.resolve({ ok: false, retryAfterMs: 3000 }),
    sleep: () => {
      switchActivation()
      return Promise.resolve()
    },
  })
  switchActivation = () => {
    env.pointer = pointer(ACT_B, b)
  }
  appendFileSync(a, textLine('hello'))
  await fw.poll()
  expect(env.sent).toEqual([[THREAD, '💬 hello']])
})

test('429 の待ちが 10 秒を超えたら送らない', async () => {
  const slept: number[] = []
  const { env, fw, a } = setupWithTarget({
    send: () => Promise.resolve({ ok: false, retryAfterMs: MAX_RETRY_WAIT_MS + 1 }),
    sleep: (ms) => {
      slept.push(ms)
      return Promise.resolve()
    },
  })
  appendFileSync(a, textLine('hello'))
  await fw.poll()
  expect(slept).toEqual([])
  expect(env.sent).toEqual([[THREAD, '💬 hello']])
})

test('transcript の読み取りが例外を投げても poll は止まらず 次の poll で読み直す', async () => {
  let reads = 0
  const reader: TailReader = {
    readNewLines: () => {
      if (reads++ === 0) throw new Error('ENOENT: no such file')
      return [textLine('retried').trimEnd()]
    },
  }
  const { env, fw } = setup({ openReader: () => reader })
  env.pointer = pointer(ACT_A, join(testTmpDir, 'a.jsonl'))
  fw.tick()
  fw.setTarget(target())
  await expect(fw.poll()).resolves.toBeUndefined()
  expect(env.sent).toEqual([])
  expect(env.logs.some((m) => m.includes('ENOENT'))).toBe(true)
  await fw.poll()
  expect(env.sent).toEqual([[THREAD, '💬 retried']])
})

test('transcript を開けなくても tick は止まらず 次の tick で開き直す', async () => {
  const a = emptyTranscript('a.jsonl')
  let opens = 0
  const { env, fw } = setup({
    openReader: () => {
      opens++
      if (opens === 1) throw new Error('EBUSY: resource busy')
      return {
        readNewLines: () => [textLine('reopened').trimEnd()],
      }
    },
  })
  env.pointer = pointer(ACT_A, a)
  expect(() => fw.tick()).not.toThrow()
  expect(env.logs.some((m) => m.includes('EBUSY'))).toBe(true)
  fw.setTarget(target())
  await fw.poll()
  expect(opens).toBe(2)
  expect(env.sent).toEqual([[THREAD, '💬 reopened']])
})
