import { test, expect } from 'bun:test'
import { PassThrough } from 'stream'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { officialPluginDir, relayLines } from '../src/proxy'

// --- relayLines ---

// src へ書き込み dst に届いた文字列を集める
function pipe(handler: Parameters<typeof relayLines>[2]): { src: PassThrough; out: () => string } {
  const src = new PassThrough()
  const dst = new PassThrough()
  let collected = ''
  dst.on('data', (c: Buffer) => { collected += c.toString('utf8') })
  relayLines(src, dst, handler)
  return { src, out: () => collected }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

test('relayLines は 1 行 1 メッセージとして handler に渡し 元の行をそのまま書き出す', async () => {
  const seen: unknown[] = []
  const { src, out } = pipe((m) => { seen.push(m); return m })
  src.write('{"jsonrpc":"2.0","id":1,"method":"a"}\n{"jsonrpc":"2.0","id":2,"method":"b"}\n')
  await tick()
  expect(seen).toEqual([
    { jsonrpc: '2.0', id: 1, method: 'a' },
    { jsonrpc: '2.0', id: 2, method: 'b' },
  ])
  expect(out()).toBe('{"jsonrpc":"2.0","id":1,"method":"a"}\n{"jsonrpc":"2.0","id":2,"method":"b"}\n')
})

test('relayLines はチャンク境界で分断された行を結合してから解析する', async () => {
  const seen: unknown[] = []
  const { src, out } = pipe((m) => { seen.push(m); return m })
  src.write('{"jsonrpc":"2.0","id":1,"me')
  await tick()
  expect(seen).toEqual([])
  expect(out()).toBe('')
  src.write('thod":"a"}\n')
  await tick()
  expect(seen).toEqual([{ jsonrpc: '2.0', id: 1, method: 'a' }])
  expect(out()).toBe('{"jsonrpc":"2.0","id":1,"method":"a"}\n')
})

test('relayLines はマルチバイト文字の途中でチャンクが切れても壊さない', async () => {
  const seen: Array<Record<string, unknown>> = []
  const { src, out } = pipe((m) => { seen.push(m); return m })
  const bytes = Buffer.from('{"text":"日本語"}\n', 'utf8')
  // "日" の UTF-8 3 バイトの途中で分割する
  src.write(bytes.subarray(0, 10))
  src.write(bytes.subarray(10))
  await tick()
  expect(seen).toEqual([{ text: '日本語' }])
  expect(out()).toBe('{"text":"日本語"}\n')
})

test('relayLines は handler が null を返した行を破棄する', async () => {
  const { src, out } = pipe((m) => (m.method === 'drop' ? null : m))
  src.write('{"method":"drop"}\n{"method":"keep"}\n')
  await tick()
  expect(out()).toBe('{"method":"keep"}\n')
})

test('relayLines は handler が別オブジェクトを返した行を再シリアライズして書き出す', async () => {
  const { src, out } = pipe((m) => ({ ...m, extra: true }))
  src.write('{"method":"x"}\n')
  await tick()
  expect(out()).toBe('{"method":"x","extra":true}\n')
})

test('relayLines は JSON として解析できない行を無条件で素通しする', async () => {
  const seen: unknown[] = []
  const { src, out } = pipe((m) => { seen.push(m); return null })
  src.write('not json\n')
  await tick()
  expect(seen).toEqual([])
  expect(out()).toBe('not json\n')
})

test('relayLines は空行を無視する', async () => {
  const seen: unknown[] = []
  const { src, out } = pipe((m) => { seen.push(m); return m })
  src.write('\n   \n{"method":"x"}\n')
  await tick()
  expect(seen).toEqual([{ method: 'x' }])
  expect(out()).toBe('{"method":"x"}\n')
})

// --- officialPluginDir ---

function withRegistry(registry: unknown, fn: (configDir: string) => void): void {
  const dir = join(tmpdir(), `cc-discord-proxy-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`)
  mkdirSync(join(dir, 'plugins'), { recursive: true })
  writeFileSync(join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify(registry))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('officialPluginDir は user scope の installPath を優先する', () => {
  withRegistry({
    plugins: {
      'discord@claude-plugins-official': [
        { scope: 'project', installPath: 'C:\\proj\\discord' },
        { scope: 'user', installPath: 'C:\\user\\discord' },
      ],
    },
  }, (dir) => {
    expect(officialPluginDir(dir)).toBe('C:\\user\\discord')
  })
})

test('officialPluginDir は user scope が無ければ先頭のエントリを使う', () => {
  withRegistry({
    plugins: {
      'discord@claude-plugins-official': [{ scope: 'project', installPath: 'C:\\proj\\discord' }],
    },
  }, (dir) => {
    expect(officialPluginDir(dir)).toBe('C:\\proj\\discord')
  })
})

test('officialPluginDir は公式プラグイン未インストール時に throw する', () => {
  withRegistry({ plugins: {} }, (dir) => {
    expect(() => officialPluginDir(dir)).toThrow('not installed')
  })
})
