import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { decideChannel, findOwnClaude, selectPointer } from '../src/binding'
import type { ProcessInfo, ProcessLookup } from '../src/process-tree'

const ROOT = 'D:\\work\\cc-discord\\plugin'
const runner: ProcessInfo = { pid: 10, ppid: 20, startMs: 5_000, argv: ['bun.exe', 'run', '--cwd', 'D:/work/cc-discord/plugin', 'start'] }
const claude: ProcessInfo = { pid: 20, ppid: 30, startMs: 1_000, argv: ['claude', '--channels', 'plugin:cc-discord@cc-discord'] }

// プロセスの一覧から lookup を作る
function table(...infos: ProcessInfo[]): (pid: number) => ProcessLookup {
  return (pid) => {
    const info = infos.find((i) => i.pid === pid)
    return info ? { kind: 'found', info } : { kind: 'missing' }
  }
}

test('findOwnClaude は run と --cwd <プラグインのディレクトリ> を持つ中継を飛ばして Claude Code を返す', () => {
  expect(findOwnClaude(10, ROOT, table(runner, claude))).toEqual(claude)
})

test('findOwnClaude は --cwd の値の区切り文字の違いを同一視する', () => {
  const back = { ...runner, argv: ['bun.exe', 'run', '--cwd', ROOT, 'start'] }
  expect(findOwnClaude(10, 'D:/work/cc-discord/plugin', table(back, claude))).toEqual(claude)
})

test('findOwnClaude は末尾の区切り文字の違いを同一視する', () => {
  const trailing = { ...runner, argv: ['bun.exe', 'run', '--cwd', 'D:/work/cc-discord/plugin/', 'start'] }
  expect(findOwnClaude(10, ROOT, table(trailing, claude))).toEqual(claude)
  expect(findOwnClaude(10, `${ROOT}\\`, table(runner, claude))).toEqual(claude)
})

test('findOwnClaude は win32 のときだけ大文字小文字を同一視する', () => {
  const lower = { ...runner, argv: ['bun.exe', 'run', '--cwd', 'd:/work/CC-Discord/plugin', 'start'] }
  expect(findOwnClaude(10, ROOT, table(lower, claude), undefined, 'win32')).toEqual(claude)
  expect(findOwnClaude(10, ROOT, table(lower, claude), undefined, 'linux')).toEqual(lower)
})

test('findOwnClaude は --cwd=<値> の形も読む', () => {
  const equals = { ...runner, argv: ['bun.exe', 'run', '--cwd=D:/work/cc-discord/plugin', 'start'] }
  expect(findOwnClaude(10, ROOT, table(equals, claude))).toEqual(claude)
})

test('findOwnClaude はシンボリックリンクとその実体を同じディレクトリとみなす', () => {
  const dir = mkdtempSync(join(tmpdir(), 'binding-'))
  try {
    const real = join(dir, 'real')
    const link = join(dir, 'link')
    mkdirSync(real)
    symlinkSync(real, link, 'junction')
    const viaReal = { ...runner, argv: ['bun', 'run', '--cwd', realpathSync.native(real), 'start'] }
    expect(findOwnClaude(10, link, table(viaReal, claude))).toEqual(claude)
    const viaLink = { ...runner, argv: ['bun', 'run', '--cwd', link, 'start'] }
    expect(findOwnClaude(10, real, table(viaLink, claude))).toEqual(claude)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('findOwnClaude は run を持たないか --cwd が別のディレクトリのプロセスを中継とみなさない', () => {
  const noRun = { ...runner, argv: ['bun.exe', '--cwd', 'D:/work/cc-discord/plugin', 'start'] }
  expect(findOwnClaude(10, ROOT, table(noRun, claude))).toEqual(noRun)
  const other = { ...runner, argv: ['bun.exe', 'run', '--cwd', 'D:/work/other', 'start'] }
  expect(findOwnClaude(10, ROOT, table(other, claude))).toEqual(other)
})

test('findOwnClaude は --plugin-dir <プラグインのディレクトリ> を持つ内側の Claude Code を中継とみなさない', () => {
  const inner = { pid: 20, ppid: 40, startMs: 1_000, argv: ['claude', '--plugin-dir', ROOT] }
  const outer = { pid: 40, ppid: 50, startMs: 100, argv: ['claude', '--channels', 'plugin:cc-discord@cc-discord'] }
  expect(findOwnClaude(10, ROOT, table(runner, inner, outer))).toEqual(inner)
})

test('findOwnClaude はプロンプトの本文にプラグインのディレクトリを含む Claude Code を中継とみなさない', () => {
  const prompted = { pid: 20, ppid: 40, startMs: 1_000, argv: ['claude', '-p', `run --cwd ${ROOT} を調べて`] }
  const outer = { pid: 40, ppid: 50, startMs: 100, argv: ['claude'] }
  expect(findOwnClaude(10, ROOT, table(runner, prompted, outer))).toEqual(prompted)
})

test('findOwnClaude は中継以外の最初のプロセスで打ち切り 外側へ進まない', () => {
  const shell = { pid: 15, ppid: 20, startMs: 2_000, argv: ['bash', '-c', `bun run ${ROOT}`] }
  const viaShell = { ...runner, ppid: 15 }
  expect(findOwnClaude(10, ROOT, table(viaShell, shell, claude))).toEqual(shell)
})

test('findOwnClaude は startPid 自身が中継以外ならそれを返す', () => {
  expect(findOwnClaude(20, ROOT, table(runner, claude))).toEqual(claude)
})

test('findOwnClaude は起動引数を取得できなかったプロセスを中継以外として返す', () => {
  const noArgv = { ...claude, argv: null }
  expect(findOwnClaude(10, ROOT, table(runner, noArgv))).toEqual(noArgv)
})

test('findOwnClaude は lookup が missing か error を返したら null を返す', () => {
  expect(findOwnClaude(10, ROOT, table(runner))).toBeNull()
  expect(findOwnClaude(10, ROOT, () => ({ kind: 'error' }))).toBeNull()
})

test('findOwnClaude は上限の段数までに中継以外が現れなければ null を返す', () => {
  const seen: number[] = []
  const lookup = (pid: number): ProcessLookup => {
    seen.push(pid)
    return { kind: 'found', info: { ...runner, pid, ppid: pid + 1 } }
  }
  expect(findOwnClaude(10, ROOT, lookup, 3)).toBeNull()
  expect(seen).toEqual([10, 11, 12])
})

test('findOwnClaude は親の PID が自分自身に戻る循環でも上限で止まる', () => {
  const loop = (pid: number): ProcessLookup => ({ kind: 'found', info: { ...runner, pid, ppid: pid } })
  expect(findOwnClaude(10, ROOT, loop)).toBeNull()
})

test('resume で書かれたポインタも claude_started_at が一致すれば採用する', () => {
  const p = { claude_pid: 20, claude_started_at: 1_000 }
  expect(selectPointer(claude, (pid) => (pid === 20 ? p : null))).toBe(p)
})

test('claude_started_at が一致しないポインタは採用しない', () => {
  const p = { claude_pid: 20, claude_started_at: 999 }
  expect(selectPointer(claude, (pid) => (pid === 20 ? p : null))).toBeNull()
})

test('claude_started_at を持たない旧形式のポインタは採用しない', () => {
  const p = { claude_pid: 20 }
  expect(selectPointer(claude, (pid) => (pid === 20 ? p : null))).toBeNull()
})

test('claude_pid が own の PID と異なるポインタは採用しない', () => {
  const p = { claude_pid: 21, claude_started_at: 1_000 }
  expect(selectPointer(claude, () => p)).toBeNull()
})

test('自分の Claude Code のポインタが無ければ外側の祖先のポインタがあっても null', () => {
  const inner = { ...claude, pid: 20, startMs: 1_000 }
  const outerPointer = { claude_pid: 40, claude_started_at: 100 }
  const read = (pid: number) => (pid === 40 ? outerPointer : null)
  expect(selectPointer(inner, read)).toBeNull()
})

test('own が null なら read を呼ばずに null を返す', () => {
  let called = false
  expect(selectPointer(null, () => ((called = true), null))).toBeNull()
  expect(called).toBe(false)
})

test('入れ子で外側だけが channel 付きなら内側は無効と判定する', () => {
  const inner = { pid: 20, ppid: 40, startMs: 1_000, argv: ['claude', '--plugin-dir', ROOT] }
  const outer = { pid: 40, ppid: 50, startMs: 100, argv: ['claude', '--channels', 'plugin:cc-discord@cc-discord'] }
  const own = findOwnClaude(10, ROOT, table(runner, inner, outer))
  expect(decideChannel(own, 'cc-discord', {}).enabled).toBe(false)
})

test('decideChannel は --channels の値にこのプラグインがあれば有効で 理由に PID と値を書く', () => {
  const d = decideChannel(claude, 'cc-discord', {})
  expect(d.enabled).toBe(true)
  expect(d.reason).toContain('20')
  expect(d.reason).toContain('plugin:cc-discord@cc-discord')
})

test('decideChannel は = 付きの指定と複数の値とカンマ区切りを読む', () => {
  for (const argv of [
    ['claude', '--channels=plugin:cc-discord@cc-discord'],
    ['claude', '--channels', 'plugin:telegram@claude-plugins-official', 'plugin:cc-discord@cc-discord'],
    ['claude', '--channels', 'plugin:a@b,plugin:cc-discord@x'],
    ['claude', '--dangerously-load-development-channels', 'plugin:cc-discord@cc-discord-dev'],
  ]) {
    expect(decideChannel({ ...claude, argv }, 'cc-discord', {}).enabled).toBe(true)
  }
})

test('decideChannel は公式だけを指すフラグや次のフラグの後の値を無効と判定する', () => {
  for (const argv of [
    ['claude', '--channels', 'plugin:discord@claude-plugins-official'],
    ['claude', '--channels', 'plugin:x@y', '--model', 'plugin:cc-discord@z'],
    ['claude', '--model', 'plugin:cc-discord@z'],
    ['claude'],
  ]) {
    expect(decideChannel({ ...claude, argv }, 'cc-discord', {}).enabled).toBe(false)
  }
})

test('decideChannel は別のプラグインの名前を前方一致で有効としない', () => {
  const argv = ['claude', '--channels', 'plugin:cc-discord-extra@x']
  expect(decideChannel({ ...claude, argv }, 'cc-discord', {}).enabled).toBe(false)
})

test('CC_DISCORD_CHANNEL が on か off なら起動引数より優先し 理由に上書きと書く', () => {
  const off = decideChannel(claude, 'cc-discord', { CC_DISCORD_CHANNEL: 'off' })
  expect(off.enabled).toBe(false)
  expect(off.reason).toContain('上書き')
  const noFlag = { ...claude, argv: ['claude'] }
  const on = decideChannel(noFlag, 'cc-discord', { CC_DISCORD_CHANNEL: 'on' })
  expect(on.enabled).toBe(true)
  expect(on.reason).toContain('上書き')
  expect(decideChannel(null, 'cc-discord', { CC_DISCORD_CHANNEL: 'on' }).enabled).toBe(true)
})

test('CC_DISCORD_CHANNEL が on と off 以外なら起動引数で判定する', () => {
  expect(decideChannel(claude, 'cc-discord', { CC_DISCORD_CHANNEL: 'auto' }).enabled).toBe(true)
})

test('own が null か argv が null なら無効と判定し 理由で CC_DISCORD_CHANNEL を案内する', () => {
  for (const own of [null, { ...claude, argv: null }]) {
    const d = decideChannel(own, 'cc-discord', {})
    expect(d.enabled).toBe(false)
    expect(d.reason).toContain('CC_DISCORD_CHANNEL')
  }
})
