import { test, expect, beforeEach, afterEach } from 'bun:test'
import { spawnSync } from 'child_process'
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// CLI を子プロセスとして起動する統合テスト
// 擬似 cache / patches / marketplace を一時 dir に作り環境変数で差し替える

const SCRIPT = join(import.meta.dir, '..', 'src', 'patch-server.ts')
let root: string
let cache: string
let patches: string
let market: string

// 素の server.ts (bun build が通る内容)
const BASE = 'const a = 1\nconst b = 2\nconst c = 3\nconsole.log(a + b + c)\n'
// 改変済み server.ts (有効な TS)
const PATCHED = 'const a = 1\nconst b = 20\nconst c = 3\nconsole.log(a + b + c)\nconst added = true\nconsole.log(added)\n'
// 適用すると構文エラーになる改変 (git apply は通るが bun build が落ちる)
const BROKEN = 'const a = 1\nconst b = 2\nconst c = 3\nconsole.log(a + b + c)\nconst = broken\n'

// git diff --no-index で fixture 用 patch を生成しヘッダを server.ts に揃える
function makePatch(baseText: string, patchedText: string): string {
  const d = join(root, `mk-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'base.ts'), baseText)
  writeFileSync(join(d, 'mod.ts'), patchedText)
  const r = spawnSync('git', ['diff', '--no-index', '--', 'base.ts', 'mod.ts'], {
    cwd: d, encoding: 'utf8',
  })
  return r.stdout
    .replaceAll('a/base.ts', 'a/server.ts')
    .replaceAll('b/mod.ts', 'b/server.ts')
}

function runCli(args: string[] = []): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('bun', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CC_DISCORD_PLUGIN_CACHE: cache,
      CC_DISCORD_PATCHES_DIR: patches,
      CC_DISCORD_MARKETPLACE_DIR: market,
    },
  })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

beforeEach(() => {
  root = join(tmpdir(), `patch-server-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`)
  cache = join(root, 'cache')
  patches = join(root, 'patches')
  market = join(root, 'market')
  mkdirSync(join(cache, '0.0.4'), { recursive: true })
  mkdirSync(patches, { recursive: true })
  mkdirSync(market, { recursive: true })
  writeFileSync(join(cache, '0.0.4', 'server.ts'), BASE)
  writeFileSync(join(cache, '0.0.4', 'package.json'), '{"version":"0.0.1"}\n')
  writeFileSync(join(market, 'server.ts'), BASE)
  writeFileSync(join(market, 'package.json'), '{"version":"0.0.1"}\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

test('未適用キャッシュに適用し .orig を残して成功する', () => {
  writeFileSync(join(patches, '0.0.4.patch'), makePatch(BASE, PATCHED))
  const r = runCli()
  expect(r.status).toBe(0)
  expect(readFileSync(join(cache, '0.0.4', 'server.ts'), 'utf8')).toBe(PATCHED)
  expect(readFileSync(join(cache, '0.0.4', 'server.ts.orig'), 'utf8')).toBe(BASE)
  expect(r.stdout).toContain('再起動')
})

test('適用済みキャッシュには何もしない (冪等)', () => {
  writeFileSync(join(patches, '0.0.4.patch'), makePatch(BASE, PATCHED))
  expect(runCli().status).toBe(0)
  const r = runCli()
  expect(r.status).toBe(0)
  expect(r.stdout).toContain('適用済み')
  expect(readFileSync(join(cache, '0.0.4', 'server.ts'), 'utf8')).toBe(PATCHED)
})

test('当たらないパッチでは何も変更せず exit 1', () => {
  const other = 'totally different content\nanother line\n'
  writeFileSync(join(patches, '0.0.4.patch'), makePatch(other, other + 'x\n'))
  const r = runCli()
  expect(r.status).toBe(1)
  expect(readFileSync(join(cache, '0.0.4', 'server.ts'), 'utf8')).toBe(BASE)
  expect(existsSync(join(cache, '0.0.4', 'server.ts.orig'))).toBe(false)
  expect(r.stderr).toContain('適用できない')
})

test('patch が無ければ exit 1', () => {
  const r = runCli()
  expect(r.status).toBe(1)
})

test('複数バージョンでは数値順で最新が対象になる', () => {
  mkdirSync(join(cache, '0.0.10'), { recursive: true })
  writeFileSync(join(cache, '0.0.10', 'server.ts'), BASE)
  writeFileSync(join(patches, '0.0.10.patch'), makePatch(BASE, PATCHED))
  const r = runCli()
  expect(r.status).toBe(0)
  expect(readFileSync(join(cache, '0.0.10', 'server.ts'), 'utf8')).toBe(PATCHED)
  expect(readFileSync(join(cache, '0.0.4', 'server.ts'), 'utf8')).toBe(BASE)
})

test('フォールバック適用が成功すると対象バージョンの patch として保存される', () => {
  writeFileSync(join(patches, '0.0.3.patch'), makePatch(BASE, PATCHED))
  const r = runCli()
  expect(r.status).toBe(0)
  expect(existsSync(join(patches, '0.0.4.patch'))).toBe(true)
  expect(readFileSync(join(patches, '0.0.4.patch'), 'utf8'))
    .toBe(readFileSync(join(patches, '0.0.3.patch'), 'utf8'))
  expect(r.stdout).toContain('0.0.4.patch')
})

test('適用後の bun build が失敗したら復元して exit 1', () => {
  writeFileSync(join(patches, '0.0.4.patch'), makePatch(BASE, BROKEN))
  const r = runCli()
  expect(r.status).toBe(1)
  expect(readFileSync(join(cache, '0.0.4', 'server.ts'), 'utf8')).toBe(BASE)
  expect(r.stderr).toContain('復元')
})

test('build 失敗時の復元は stale な .orig でなく適用直前の内容に戻す', () => {
  writeFileSync(join(patches, '0.0.4.patch'), makePatch(BASE, BROKEN))
  // 過去の適用で作られた古い .orig が現物と異なる状況を再現する
  writeFileSync(join(cache, '0.0.4', 'server.ts.orig'), 'stale orig content\n')
  const r = runCli()
  expect(r.status).toBe(1)
  expect(readFileSync(join(cache, '0.0.4', 'server.ts'), 'utf8')).toBe(BASE)
})

test('--make は .orig から patch を再生成しローカルパスを含めない', () => {
  writeFileSync(join(cache, '0.0.4', 'server.ts'), PATCHED)
  writeFileSync(join(cache, '0.0.4', 'server.ts.orig'), BASE)
  const r = runCli(['--make'])
  expect(r.status).toBe(0)
  const made = readFileSync(join(patches, '0.0.4.patch'), 'utf8')
  expect(made).toContain('--- a/server.ts')
  expect(made).toContain('+++ b/server.ts')
  expect(made).not.toContain(root.replaceAll('\\', '/'))
  expect(made).not.toContain('Users')
})

test('--make は .orig が無ければ marketplace の素を使う (version 一致時)', () => {
  writeFileSync(join(cache, '0.0.4', 'server.ts'), PATCHED)
  const r = runCli(['--make'])
  expect(r.status).toBe(0)
  expect(r.stdout).toContain('marketplace')
  expect(existsSync(join(patches, '0.0.4.patch'))).toBe(true)
})

test('--make は package.json version 不一致なら素を採用せず exit 1', () => {
  writeFileSync(join(cache, '0.0.4', 'server.ts'), PATCHED)
  writeFileSync(join(market, 'package.json'), '{"version":"9.9.9"}\n')
  const r = runCli(['--make'])
  expect(r.status).toBe(1)
  expect(r.stderr).toContain('不一致')
})

test('--make は差分が無ければ exit 1', () => {
  const r = runCli(['--make'])
  expect(r.status).toBe(1)
  expect(r.stderr).toContain('差分が無い')
})

test('--make で生成した patch は素のキャッシュにそのまま適用できる (ラウンドトリップ)', () => {
  writeFileSync(join(cache, '0.0.4', 'server.ts'), PATCHED)
  writeFileSync(join(cache, '0.0.4', 'server.ts.orig'), BASE)
  expect(runCli(['--make']).status).toBe(0)
  writeFileSync(join(cache, '0.0.4', 'server.ts'), BASE)
  rmSync(join(cache, '0.0.4', 'server.ts.orig'))
  expect(runCli().status).toBe(0)
  expect(readFileSync(join(cache, '0.0.4', 'server.ts'), 'utf8')).toBe(PATCHED)
})
