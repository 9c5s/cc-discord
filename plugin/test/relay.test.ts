import { test, expect } from 'bun:test'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { createWriter, readJsonLines } from '../src/relay'

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

// 受け取ったメッセージを集める読み取り口を作る
function reader(onMessage?: (m: Record<string, unknown>) => Promise<void> | void) {
  const src = new PassThrough()
  const seen: Array<Record<string, unknown>> = []
  const invalid: string[] = []
  let ended = false
  readJsonLines(src, {
    onMessage: async (m) => {
      seen.push(m)
      await onMessage?.(m)
    },
    onInvalid: (line) => invalid.push(line),
    onEnd: () => {
      ended = true
    },
  })
  return { src, seen, invalid, ended: () => ended }
}

// write の戻り値を制御できる書き込み先
class FakeWritable extends EventEmitter {
  written: string[] = []
  accept = true
  write(s: string): boolean {
    this.written.push(s)
    return this.accept
  }
}

const asStream = (w: FakeWritable): NodeJS.WritableStream => w as unknown as NodeJS.WritableStream

// --- readJsonLines ---

test('readJsonLines は 1 行 1 メッセージとして handler に渡す', async () => {
  const r = reader()
  r.src.write('{"jsonrpc":"2.0","id":1,"method":"a"}\n{"jsonrpc":"2.0","id":2,"method":"b"}\n')
  await tick()
  expect(r.seen).toEqual([
    { jsonrpc: '2.0', id: 1, method: 'a' },
    { jsonrpc: '2.0', id: 2, method: 'b' },
  ])
})

test('readJsonLines はチャンク境界で分断された行を結合してから解析する', async () => {
  const r = reader()
  r.src.write('{"jsonrpc":"2.0","id":1,"me')
  await tick()
  expect(r.seen).toEqual([])
  r.src.write('thod":"a"}\n')
  await tick()
  expect(r.seen).toEqual([{ jsonrpc: '2.0', id: 1, method: 'a' }])
})

test('readJsonLines はマルチバイト文字の途中でチャンクが切れても壊さない', async () => {
  const r = reader()
  const bytes = Buffer.from('{"text":"日本語"}\n', 'utf8')
  r.src.write(bytes.subarray(0, 10))
  r.src.write(bytes.subarray(10))
  await tick()
  expect(r.seen).toEqual([{ text: '日本語' }])
})

test('readJsonLines は解析できない行を転送せず onInvalid に渡す', async () => {
  const r = reader()
  r.src.write('not json\n{"method":"x"}\n')
  await tick()
  expect(r.seen).toEqual([{ method: 'x' }])
  expect(r.invalid).toEqual(['not json'])
})

test('readJsonLines は JSON でもオブジェクトでない行を onInvalid に渡す', async () => {
  const r = reader()
  r.src.write('42\n"text"\nnull\n')
  await tick()
  expect(r.seen).toEqual([])
  expect(r.invalid).toEqual(['42', '"text"', 'null'])
})

test('readJsonLines は空行を無視する', async () => {
  const r = reader()
  r.src.write('\n   \n{"method":"x"}\n')
  await tick()
  expect(r.seen).toEqual([{ method: 'x' }])
  expect(r.invalid).toEqual([])
})

test('readJsonLines は EOF 時の未終端の最終行も処理する', async () => {
  const r = reader()
  r.src.write('{"method":"x"}')
  r.src.end()
  await tick()
  expect(r.seen).toEqual([{ method: 'x' }])
})

test('readJsonLines は EOF を処理の完了後に通知する', async () => {
  const order: string[] = []
  const src = new PassThrough()
  let done: (() => void) | null = null
  readJsonLines(src, {
    onMessage: () => new Promise<void>((r) => {
      order.push('message')
      done = r
    }),
    onEnd: () => order.push('end'),
  })
  src.write('{"method":"x"}\n')
  await tick()
  src.end()
  await tick()
  expect(order).toEqual(['message'])
  done?.()
  await tick()
  expect(order).toEqual(['message', 'end'])
})

test('readJsonLines は前のメッセージの処理が終わるまで次を渡さない', async () => {
  const order: string[] = []
  const src = new PassThrough()
  const resolvers: Array<() => void> = []
  readJsonLines(src, {
    onMessage: (m) => new Promise<void>((r) => {
      order.push(`start:${String(m.id)}`)
      resolvers.push(() => {
        order.push(`done:${String(m.id)}`)
        r()
      })
    }),
  })
  src.write('{"id":1}\n{"id":2}\n')
  await tick()
  expect(order).toEqual(['start:1'])
  resolvers[0]()
  await tick()
  expect(order).toEqual(['start:1', 'done:1', 'start:2'])
})

// --- createWriter ---

test('createWriter は書いた順に改行付きで書き出す', async () => {
  const dst = new FakeWritable()
  const w = createWriter(asStream(dst))
  w.write('{"a":1}')
  w.write('{"b":2}')
  await tick()
  expect(dst.written).toEqual(['{"a":1}\n', '{"b":2}\n'])
})

test('createWriter は write が false を返したら drain を待ってから次を書く', async () => {
  const dst = new FakeWritable()
  dst.accept = false
  const w = createWriter(asStream(dst))
  w.write('a')
  w.write('b')
  await tick()
  expect(dst.written).toEqual(['a\n'])
  dst.accept = true
  dst.emit('drain')
  await tick()
  expect(dst.written).toEqual(['a\n', 'b\n'])
})

test('createWriter は書き込みエラーで待機中のメッセージを破棄する', async () => {
  const dst = new FakeWritable()
  dst.accept = false
  let broken = false
  const w = createWriter(asStream(dst), () => {
    broken = true
  })
  w.write('a')
  w.write('b')
  await tick()
  dst.emit('error', new Error('EPIPE'))
  await tick()
  expect(broken).toBe(true)
  expect(w.broken).toBe(true)
  dst.accept = true
  dst.emit('drain')
  await tick()
  expect(dst.written).toEqual(['a\n'])
})

test('createWriter は破損後の書き込みを無視する', async () => {
  const dst = new FakeWritable()
  const w = createWriter(asStream(dst))
  dst.emit('error', new Error('EPIPE'))
  w.write('a')
  await tick()
  expect(dst.written).toEqual([])
})

test('createWriter は write が投げても破損として扱う', async () => {
  const dst = new FakeWritable()
  dst.write = () => {
    throw new Error('closed')
  }
  let broken = false
  const w = createWriter(asStream(dst), () => {
    broken = true
  })
  w.write('a')
  await tick()
  expect(broken).toBe(true)
  expect(w.broken).toBe(true)
})
