import { test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { dirname, join, relative } from 'path'
import {
  TRACKED_FILES,
  compareDirs,
  defaultCloneDir,
  mergeUpstream,
  readVersion,
  sha256File,
  type MergeRunner,
} from '../upstream'

const SOURCE = 'anthropics/claude-plugins-official/external_plugins/discord'

let tmp: string
let repoRoot: string
let newDir: string
let upstreamDir: string
let pluginDir: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'upstream-test-'))
  repoRoot = join(tmp, 'repo')
  newDir = join(tmp, 'new')
  upstreamDir = join(repoRoot, 'upstream', 'discord')
  pluginDir = join(repoRoot, 'plugin')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function write(dir: string, rel: string, content: string): void {
  const path = join(dir, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function read(dir: string, rel: string): string {
  return readFileSync(join(dir, rel), 'utf8')
}

function pluginJson(version: string): string {
  return JSON.stringify({ name: 'discord', version })
}

type ServerBodies = { base: string; plugin: string; next: string }

// 追跡対象を 3 組へ作る (server.ts 以外は 3 組とも同じ内容)
function seed(server: ServerBodies, version = '0.0.6'): void {
  for (const f of TRACKED_FILES) {
    if (f === 'server.ts') {
      write(upstreamDir, f, server.base)
      write(pluginDir, f, server.plugin)
      write(newDir, f, server.next)
    } else {
      for (const dir of [upstreamDir, pluginDir, newDir]) write(dir, f, `same ${f}\n`)
    }
  }
  write(upstreamDir, '.claude-plugin/plugin.json', pluginJson('0.0.5'))
  write(newDir, '.claude-plugin/plugin.json', pluginJson(version))
}

const SAME: ServerBodies = { base: 'a\n', plugin: 'a\n', next: 'a\n' }

// ディレクトリ配下の全ファイルを相対パスと内容の対応で返す
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out[relative(dir, p).replaceAll('\\', '/')] = readFileSync(p, 'utf8')
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}

const cleanRun: MergeRunner = () => ({ code: 0, stdout: 'merged\n' })

test('改変と重ならない上流の変更は衝突なしで取り込む', () => {
  seed({ base: 'a\nb\nc\n', plugin: 'a\nB\nc\n', next: 'a\nb\nc\nd\n' })

  const result = mergeUpstream({ repoRoot, newDir })

  expect(result.conflicts).toEqual([])
  expect(result.version).toBe('0.0.6')
  expect(read(pluginDir, 'server.ts')).toBe('a\nB\nc\nd\n')
  expect(read(upstreamDir, 'server.ts')).toBe(read(newDir, 'server.ts'))
})

test('改変と重なる変更は衝突マーカーを残して報告する', () => {
  seed({ base: 'x\n', plugin: 'y\n', next: 'z\n' })

  const result = mergeUpstream({ repoRoot, newDir })

  expect(result.conflicts).toEqual(['server.ts'])
  const merged = read(pluginDir, 'server.ts')
  expect(merged).toContain('<<<<<<<')
  expect(merged).not.toContain(tmp)
  expect(read(upstreamDir, 'server.ts')).toBe('z\n')
})

test('upstream.json の版と hash を新版に更新する', () => {
  seed({ base: 'a\n', plugin: 'a\n', next: 'a2\n' }, '0.0.6')
  write(pluginDir, 'upstream.json', JSON.stringify({ source: SOURCE, version: '0.0.5', server_sha256: 'old' }))

  mergeUpstream({ repoRoot, newDir, run: cleanRun })

  expect(JSON.parse(read(pluginDir, 'upstream.json'))).toEqual({
    source: SOURCE,
    version: '0.0.6',
    server_sha256: sha256File(join(newDir, 'server.ts')),
  })
})

test('upstream.json が無くても新しく作る', () => {
  seed(SAME)

  mergeUpstream({ repoRoot, newDir, run: cleanRun })

  expect(JSON.parse(read(pluginDir, 'upstream.json')).version).toBe('0.0.6')
})

test('追跡対象でない新しいファイルを added に挙げる', () => {
  seed(SAME)
  write(newDir, 'extra.ts', 'x\n')
  write(newDir, 'skills/new/SKILL.md', 'x\n')
  write(newDir, 'README.md', 'x\n')
  write(newDir, 'ACCESS.md', 'x\n')
  write(newDir, 'bun.lock', 'x\n')
  write(newDir, 'node_modules/pkg/index.js', 'x\n')

  const result = mergeUpstream({ repoRoot, newDir, run: cleanRun })

  expect(result.added).toEqual(['extra.ts', 'skills/new/SKILL.md'])
})

test('bun.lock と plugin.json は upstream に写すだけで plugin へは書かない', () => {
  seed(SAME)
  write(upstreamDir, 'bun.lock', 'old lock\n')
  write(newDir, 'bun.lock', 'new lock\n')

  mergeUpstream({ repoRoot, newDir, run: cleanRun })

  expect(read(upstreamDir, 'bun.lock')).toBe('new lock\n')
  expect(read(upstreamDir, '.claude-plugin/plugin.json')).toBe(pluginJson('0.0.6'))
  expect(existsSync(join(pluginDir, 'bun.lock'))).toBe(false)
  expect(existsSync(join(pluginDir, '.claude-plugin', 'plugin.json'))).toBe(false)
})

test('新版に無くなった上流の副産物ファイルは upstream から取り除く', () => {
  seed(SAME)
  write(upstreamDir, 'bun.lock', 'old lock\n')

  mergeUpstream({ repoRoot, newDir, run: cleanRun })

  expect(existsSync(join(upstreamDir, 'bun.lock'))).toBe(false)
})

test('plugin に無い追跡対象は新版をそのまま写す', () => {
  seed({ base: 'a\n', plugin: 'a\n', next: 'a\n' })
  rmSync(join(pluginDir, 'package.json'))
  write(newDir, 'package.json', 'new package\n')
  const calls: string[] = []

  mergeUpstream({
    repoRoot,
    newDir,
    run: (ours) => {
      calls.push(ours)
      return { code: 0, stdout: 'merged\n' }
    },
  })

  expect(read(pluginDir, 'package.json')).toBe('new package\n')
  expect(calls).not.toContain(join(pluginDir, 'package.json'))
})

test('run には plugin と上流の基準版と新版の順でパスを渡す', () => {
  seed(SAME)
  const calls: string[][] = []

  mergeUpstream({
    repoRoot,
    newDir,
    run: (ours, base, theirs) => {
      calls.push([ours, base, theirs])
      return { code: 0, stdout: 'merged\n' }
    },
  })

  expect(calls).toHaveLength(TRACKED_FILES.length)
  expect(calls[0]).toEqual([
    join(pluginDir, TRACKED_FILES[0]),
    join(upstreamDir, TRACKED_FILES[0]),
    join(newDir, TRACKED_FILES[0]),
  ])
})

test('compareDirs は内容が変わった追跡対象だけを changed に挙げる', () => {
  const baseDir = join(tmp, 'base')
  write(baseDir, 'server.ts', 'a\n')
  write(baseDir, 'package.json', 'p\n')
  write(baseDir, 'bun.lock', 'old\n')
  write(newDir, 'server.ts', 'a2\n')
  write(newDir, 'package.json', 'p\n')
  write(newDir, 'bun.lock', 'new\n')
  write(newDir, 'extra.ts', 'x\n')

  expect(compareDirs(baseDir, newDir)).toEqual({ changed: ['server.ts'], added: ['extra.ts'] })
})

test('compareDirs は片方にしか無い追跡対象も changed に挙げる', () => {
  const baseDir = join(tmp, 'base')
  write(baseDir, 'LICENSE', 'l\n')
  write(newDir, '.npmrc', 'n\n')

  expect(compareDirs(baseDir, newDir).changed).toEqual(['.npmrc', 'LICENSE'])
})

test('git merge-file がエラーを返したら例外を投げ plugin と upstream と upstream.json を変えない', () => {
  seed({ base: 'a\n', plugin: 'a\n', next: 'a2\n' })
  write(pluginDir, 'upstream.json', '{"version":"0.0.5"}')
  const before = snapshot(repoRoot)
  let count = 0
  const run: MergeRunner = () => {
    count += 1
    return count === 2 ? { code: 255, stdout: '' } : { code: 0, stdout: 'merged\n' }
  }

  expect(() => mergeUpstream({ repoRoot, newDir, run })).toThrow(/package\.json/)

  expect(snapshot(repoRoot)).toEqual(before)
})

test('終了コードが null (シグナル終了) のときもエラーとして扱う', () => {
  seed({ base: 'a\n', plugin: 'a\n', next: 'a2\n' })
  const before = snapshot(repoRoot)

  expect(() => mergeUpstream({ repoRoot, newDir, run: () => ({ code: null, stdout: '' }) })).toThrow()

  expect(snapshot(repoRoot)).toEqual(before)
})

test('終了コード 127 は衝突として扱い 128 はエラーとして扱う', () => {
  seed(SAME)

  const conflicted = mergeUpstream({ repoRoot, newDir, run: () => ({ code: 127, stdout: 'x\n' }) })
  expect(conflicted.conflicts).toEqual([...TRACKED_FILES])

  const before = snapshot(repoRoot)
  expect(() => mergeUpstream({ repoRoot, newDir, run: () => ({ code: 128, stdout: '' }) })).toThrow()
  expect(snapshot(repoRoot)).toEqual(before)
})

test('新版に追跡対象が無ければ例外を投げ何も変えない', () => {
  seed(SAME)
  rmSync(join(newDir, '.npmrc'))
  const before = snapshot(repoRoot)

  expect(() => mergeUpstream({ repoRoot, newDir, run: cleanRun })).toThrow(/\.npmrc/)

  expect(snapshot(repoRoot)).toEqual(before)
})

test('plugin にあって上流の基準版に無い追跡対象は例外を投げ何も変えない', () => {
  seed(SAME)
  rmSync(join(upstreamDir, 'LICENSE'))
  const before = snapshot(repoRoot)

  expect(() => mergeUpstream({ repoRoot, newDir, run: cleanRun })).toThrow(/LICENSE/)

  expect(snapshot(repoRoot)).toEqual(before)
})

test('新版の版を読めなければ例外を投げ何も変えない', () => {
  seed(SAME)
  rmSync(join(newDir, '.claude-plugin', 'plugin.json'))
  const before = snapshot(repoRoot)

  expect(() => mergeUpstream({ repoRoot, newDir, run: cleanRun })).toThrow(/plugin\.json/)

  expect(snapshot(repoRoot)).toEqual(before)
})

test('defaultCloneDir は CLAUDE_CONFIG_DIR を優先し無ければ ~/.claude を使う', () => {
  const tail = ['plugins', 'marketplaces', 'claude-plugins-official', 'external_plugins', 'discord']

  expect(defaultCloneDir({ CLAUDE_CONFIG_DIR: join(tmp, 'cfg') })).toBe(join(tmp, 'cfg', ...tail))
  expect(defaultCloneDir({})).toBe(join(homedir(), '.claude', ...tail))
})

test('readVersion は plugin.json の version を返し読めなければ null を返す', () => {
  write(newDir, '.claude-plugin/plugin.json', pluginJson('1.2.3'))
  expect(readVersion(newDir)).toBe('1.2.3')

  write(newDir, '.claude-plugin/plugin.json', '{}')
  expect(readVersion(newDir)).toBeNull()

  write(newDir, '.claude-plugin/plugin.json', 'not json')
  expect(readVersion(newDir)).toBeNull()

  expect(readVersion(join(tmp, 'missing'))).toBeNull()
})

test('sha256File はファイル内容の SHA-256 を 16 進で返す', () => {
  write(tmp, 'abc.txt', 'abc')

  expect(sha256File(join(tmp, 'abc.txt'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})
