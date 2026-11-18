import { test, expect, beforeEach, afterEach } from 'bun:test'
import { createHash } from 'crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { defaultCloneDir, upstreamNotice } from '../src/upstream-notice'

const ENABLED = { CC_DISCORD_UPSTREAM_CHECK: '1' }

let root: string
let pluginDir: string
let cloneDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'discord-upstream-notice-test-'))
  pluginDir = join(root, 'plugin')
  cloneDir = join(root, 'clone')
  mkdirSync(pluginDir)
  mkdirSync(join(cloneDir, '.claude-plugin'), { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

// 取り込み済みの server.ts の内容を upstream.json に記録する
function recordImported(serverSource: string): void {
  writeFileSync(
    join(pluginDir, 'upstream.json'),
    JSON.stringify({ source: 'example/discord', version: '0.0.5', server_sha256: sha256(serverSource) }),
  )
}

// クローンに server.ts と版を置く
function placeClone(serverSource: string, version: string): void {
  writeFileSync(join(cloneDir, 'server.ts'), serverSource)
  writeFileSync(join(cloneDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'discord', version }))
}

// --- upstreamNotice ---

test('CC_DISCORD_UPSTREAM_CHECK が無ければ印を出さない', () => {
  recordImported('old')
  placeClone('new', '0.0.6')
  expect(upstreamNotice({ env: {}, pluginDir, cloneDir })).toBe(null)
})

test('CC_DISCORD_UPSTREAM_CHECK が空文字なら印を出さない', () => {
  recordImported('old')
  placeClone('new', '0.0.6')
  expect(upstreamNotice({ env: { CC_DISCORD_UPSTREAM_CHECK: '' }, pluginDir, cloneDir })).toBe(null)
})

test('クローンの server.ts の hash が upstream.json と同じなら印を出さない', () => {
  recordImported('same')
  // 版だけが進んでいても server.ts が同じなら取り込む差分は無い
  placeClone('same', '0.0.6')
  expect(upstreamNotice({ env: ENABLED, pluginDir, cloneDir })).toBe(null)
})

test('hash が違えばクローンの版を添えて upstream 0.0.6 を返す', () => {
  recordImported('old')
  placeClone('new', '0.0.6')
  expect(upstreamNotice({ env: ENABLED, pluginDir, cloneDir })).toBe('upstream 0.0.6')
})

test('クローンが無ければ印を出さない', () => {
  recordImported('old')
  rmSync(cloneDir, { recursive: true })
  expect(upstreamNotice({ env: ENABLED, pluginDir, cloneDir })).toBe(null)
})

test('upstream.json が無ければ印を出さない', () => {
  placeClone('new', '0.0.6')
  expect(upstreamNotice({ env: ENABLED, pluginDir, cloneDir })).toBe(null)
})

test('upstream.json が壊れていれば印を出さない', () => {
  writeFileSync(join(pluginDir, 'upstream.json'), '{ broken')
  placeClone('new', '0.0.6')
  expect(upstreamNotice({ env: ENABLED, pluginDir, cloneDir })).toBe(null)
})

test('upstream.json に server_sha256 が無ければ印を出さない', () => {
  writeFileSync(join(pluginDir, 'upstream.json'), JSON.stringify({ version: '0.0.5' }))
  placeClone('new', '0.0.6')
  expect(upstreamNotice({ env: ENABLED, pluginDir, cloneDir })).toBe(null)
})

test('クローンの版が読めなければ印を出さない', () => {
  recordImported('old')
  writeFileSync(join(cloneDir, 'server.ts'), 'new')
  expect(upstreamNotice({ env: ENABLED, pluginDir, cloneDir })).toBe(null)
})

test('呼ばれるたびにファイルを読み直す', () => {
  recordImported('old')
  placeClone('old', '0.0.5')
  expect(upstreamNotice({ env: ENABLED, pluginDir, cloneDir })).toBe(null)
  placeClone('new', '0.0.6')
  expect(upstreamNotice({ env: ENABLED, pluginDir, cloneDir })).toBe('upstream 0.0.6')
})

// --- defaultCloneDir ---

test('defaultCloneDir は CLAUDE_CONFIG_DIR の下の公式 marketplace のクローンを指す', () => {
  const configDir = join(root, 'config')
  expect(defaultCloneDir({ CLAUDE_CONFIG_DIR: configDir })).toBe(
    join(configDir, 'plugins', 'marketplaces', 'claude-plugins-official', 'external_plugins', 'discord'),
  )
})

test('defaultCloneDir は CLAUDE_CONFIG_DIR が無ければ ~/.claude を使う', () => {
  expect(defaultCloneDir({})).toBe(
    join(homedir(), '.claude', 'plugins', 'marketplaces', 'claude-plugins-official', 'external_plugins', 'discord'),
  )
})
