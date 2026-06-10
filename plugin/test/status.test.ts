import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildStatusBlock, readBranch } from '../src/status'

// 注: bun test はタイムゾーンを UTC に固定するため、リセット時刻の期待値は UTC 表記である
// 1781086200 = 2026-06-10 10:10 UTC, 1781406000 = 2026-06-14 03:00 UTC

test('リセット時刻の期待値は UTC 前提である (bun test の既定 TZ)', () => {
  expect(new Date(0).getTimezoneOffset()).toBe(0)
})

const fullData = {
  model: { id: 'claude-fable-5[1m]', display_name: 'Fable 5' },
  effort: { level: 'max' },
  context_window: { used_percentage: 14 },
  rate_limits: {
    five_hour: { used_percentage: 63, resets_at: 1781086200 },
    seven_day: { used_percentage: 16, resets_at: 1781406000 },
  },
}

test('buildStatusBlock は branch/model+effort/ctx+5h+7d の3行コードブロックを作る', () => {
  expect(buildStatusBlock(fullData, 'feat/channel-enhancements')).toBe(
    '```\n🌿 feat/channel-enhancements\n👾 Fable 5 | 🧠 max\n📊 14% | ⏰ 63% 10:10 | 📅 16% 6/14 3:00\n```',
  )
})

test('buildStatusBlock は effort が無ければモデル名のみにする', () => {
  const d = { ...fullData, effort: undefined }
  expect(buildStatusBlock(d, null)).toBe(
    '```\n👾 Fable 5\n📊 14% | ⏰ 63% 10:10 | 📅 16% 6/14 3:00\n```',
  )
})

test('buildStatusBlock は rate_limits が無ければ ctx のみにする', () => {
  const d = { model: { display_name: 'Fable 5' }, context_window: { used_percentage: 7 } }
  expect(buildStatusBlock(d, 'main')).toBe('```\n🌿 main\n👾 Fable 5\n📊 7%\n```')
})

test('buildStatusBlock は resets_at が無ければリセット時刻を省く', () => {
  const d = { rate_limits: { five_hour: { used_percentage: 50 } } }
  expect(buildStatusBlock(d, null)).toBe('```\n⏰ 50%\n```')
})

test('buildStatusBlock は要素が全て欠けるとき空文字を返す', () => {
  expect(buildStatusBlock({}, null)).toBe('')
})

test('readBranch は ref 形式の HEAD からブランチ名を読む', () => {
  const dir = mkdtempSync(join(tmpdir(), 'status-test-'))
  mkdirSync(join(dir, '.git'))
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/feat/channel-enhancements\n')
  expect(readBranch(dir)).toBe('feat/channel-enhancements')
})

test('readBranch は detached HEAD で短縮ハッシュを返す', () => {
  const dir = mkdtempSync(join(tmpdir(), 'status-test-'))
  mkdirSync(join(dir, '.git'))
  writeFileSync(join(dir, '.git', 'HEAD'), 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n')
  expect(readBranch(dir)).toBe('a1b2c3d')
})

test('readBranch は worktree の gitdir 参照を辿る', () => {
  const real = mkdtempSync(join(tmpdir(), 'status-test-gitdir-'))
  writeFileSync(join(real, 'HEAD'), 'ref: refs/heads/wt-branch\n')
  const dir = mkdtempSync(join(tmpdir(), 'status-test-'))
  writeFileSync(join(dir, '.git'), `gitdir: ${real}\n`)
  expect(readBranch(dir)).toBe('wt-branch')
})

test('readBranch は相対パス gitdir 参照を projectDir 基準で解決する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'status-test-relgit-'))
  const relgit = join(dir, 'relgit')
  mkdirSync(relgit)
  writeFileSync(join(relgit, 'HEAD'), 'ref: refs/heads/rel-branch\n')
  writeFileSync(join(dir, '.git'), 'gitdir: relgit\n')
  expect(readBranch(dir)).toBe('rel-branch')
})

test('readBranch は .git が無ければ null を返す', () => {
  const dir = mkdtempSync(join(tmpdir(), 'status-test-'))
  expect(readBranch(dir)).toBeNull()
})
