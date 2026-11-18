import { test, expect } from 'bun:test'
import { lookupProcess, parseProcStat, splitCommandLine } from '../src/process-tree'

test('splitCommandLine は空白で区切り二重引用符の中の空白を保つ', () => {
  expect(splitCommandLine('"C:\\a b\\claude.exe" --channels plugin:x@y')).toEqual(['C:\\a b\\claude.exe', '--channels', 'plugin:x@y'])
})

test('splitCommandLine は連続する空白と前後の空白を無視する', () => {
  expect(splitCommandLine('  bun   run  ')).toEqual(['bun', 'run'])
  expect(splitCommandLine('')).toEqual([])
})

test('splitCommandLine は引数の途中の二重引用符でも空白を保つ', () => {
  expect(splitCommandLine('bun run --cwd="D:\\my dir\\plugin" start')).toEqual(['bun', 'run', '--cwd=D:\\my dir\\plugin', 'start'])
})

test('splitCommandLine は空の二重引用符を空文字の引数として残す', () => {
  expect(splitCommandLine('a "" b')).toEqual(['a', '', 'b'])
})

test('splitCommandLine はエスケープした引用符を含む引数を 1 つの引数に保つ', () => {
  expect(splitCommandLine('claude "say \\"x\\" --channels plugin:cc-discord@y"')).toEqual(['claude', 'say "x" --channels plugin:cc-discord@y'])
})

test('splitCommandLine は閉じる引用符の直前の 2 個のバックスラッシュを 1 個にして引用を閉じる', () => {
  expect(splitCommandLine('"C:\\a b\\\\" next')).toEqual(['C:\\a b\\', 'next'])
})

test('splitCommandLine は奇数個のバックスラッシュの後の引用符をリテラルにする', () => {
  expect(splitCommandLine('a\\\\\\"b')).toEqual(['a\\"b'])
})

test('splitCommandLine は引用の外のバックスラッシュをそのまま残す', () => {
  expect(splitCommandLine('C:\\x\\y')).toEqual(['C:\\x\\y'])
})

test('splitCommandLine は引用の中の連続する二重引用符をリテラルの引用符 1 文字にする', () => {
  expect(splitCommandLine('"a ""b"" c" d')).toEqual(['a "b" c', 'd'])
})

test('parseProcStat は括弧と空白を含むコマンド名を越えて ppid と starttime を読む', () => {
  const text = '123 (my (odd) cmd) S 45 ' + Array(17).fill('0').join(' ') + ' 98765 0 0'
  expect(parseProcStat(text)).toEqual({ ppid: 45, startTicks: 98765 })
})

test('parseProcStat は形式が不正な入力で null を返す', () => {
  expect(parseProcStat('')).toBeNull()
  expect(parseProcStat('123 no parens S 45')).toBeNull()
  expect(parseProcStat('123 (cmd) S 45 0 0')).toBeNull()
  expect(parseProcStat('123 (cmd) S x ' + Array(17).fill('0').join(' ') + ' 98765')).toBeNull()
})

test('lookupProcess は実行中の自分自身の親 PID と作成時刻と起動引数を返す', () => {
  const r = lookupProcess(process.pid)
  expect(r.kind).toBe('found')
  if (r.kind !== 'found') return
  expect(r.info.pid).toBe(process.pid)
  expect(r.info.ppid).toBe(process.ppid)
  expect(r.info.startMs).toBeLessThanOrEqual(Date.now())
  expect(Date.now() - r.info.startMs).toBeLessThan(10 * 60_000)
  expect(r.info.argv?.length).toBeGreaterThan(0)
})

test('lookupProcess は親の作成時刻が自分より前である', () => {
  const self = lookupProcess(process.pid)
  const parent = lookupProcess(process.ppid)
  expect(self.kind).toBe('found')
  expect(parent.kind).toBe('found')
  if (self.kind !== 'found' || parent.kind !== 'found') return
  expect(parent.info.startMs).toBeLessThanOrEqual(self.info.startMs)
})

test('lookupProcess は同じ PID に対して同じ作成時刻を返す', () => {
  const a = lookupProcess(process.pid)
  const b = lookupProcess(process.pid)
  expect(a.kind).toBe('found')
  expect(b.kind).toBe('found')
  if (a.kind !== 'found' || b.kind !== 'found') return
  expect(b.info.startMs).toBe(a.info.startMs)
})

test('lookupProcess は別プロセスの親 PID と起動引数を返し終了後は missing を返す', async () => {
  const args = ['-e', 'setTimeout(()=>{},30000)']
  const child = Bun.spawn([process.execPath, ...args], { stdout: 'ignore', stderr: 'ignore' })
  try {
    const r = lookupProcess(child.pid)
    expect(r.kind).toBe('found')
    if (r.kind !== 'found') return
    expect(r.info.pid).toBe(child.pid)
    expect(r.info.ppid).toBe(process.pid)
    expect(r.info.argv?.slice(1)).toEqual(args)
  } finally {
    child.kill()
    await child.exited
  }
  expect(lookupProcess(child.pid).kind).toBe('missing')
})

test('lookupProcess は存在しない PID で missing を返す', () => expect(lookupProcess(99_999_999).kind).toBe('missing'))

test('lookupProcess は PID として扱えない値で error を返す', () => {
  expect(lookupProcess(0).kind).toBe('error')
  expect(lookupProcess(-1).kind).toBe('error')
  expect(lookupProcess(1.5).kind).toBe('error')
  expect(lookupProcess(Number.NaN).kind).toBe('error')
})
