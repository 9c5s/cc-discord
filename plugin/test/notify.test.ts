import { test, expect, beforeEach, afterEach } from 'bun:test'
import { writeRoute } from '../src/routes'
import { ownerName, channelId, progressChannelId } from '../src/notify'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// テスト用の一時ディレクトリを設定して、本番 state を保護する。
// routes.test.ts と同じパターンを踏襲する。
const testTmpDir = join(tmpdir(), `discord-notify-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`)

// 各テストの実行前後で環境変数を正確に復元するためにバックアップを保持する。
let savedStateDir: string | undefined
let savedProjectDir: string | undefined

beforeEach(() => {
  savedStateDir = process.env.DISCORD_STATE_DIR
  savedProjectDir = process.env.CLAUDE_PROJECT_DIR
  process.env.DISCORD_STATE_DIR = join(testTmpDir, 'state')
  mkdirSync(process.env.DISCORD_STATE_DIR, { recursive: true })
})

afterEach(() => {
  if (existsSync(testTmpDir)) {
    rmSync(testTmpDir, { recursive: true, force: true })
  }
  // 環境変数を確実に復元する
  if (savedStateDir === undefined) {
    delete process.env.DISCORD_STATE_DIR
  } else {
    process.env.DISCORD_STATE_DIR = savedStateDir
  }
  if (savedProjectDir === undefined) {
    delete process.env.CLAUDE_PROJECT_DIR
  } else {
    process.env.CLAUDE_PROJECT_DIR = savedProjectDir
  }
})

// --- ownerName のテスト ---

test('ownerName: CLAUDE_PROJECT_DIR 設定時にベース名を正規化して返す', () => {
  process.env.CLAUDE_PROJECT_DIR = 'D:\\projects\\My Proj'
  expect(ownerName()).toBe('my-proj')
})

test('ownerName: 末尾セパレータ付きでも同じ名前を返す', () => {
  process.env.CLAUDE_PROJECT_DIR = 'D:\\projects\\My Proj\\'
  expect(ownerName()).toBe('my-proj')
})

test('ownerName: スラッシュ区切りのパスでも正規化する', () => {
  process.env.CLAUDE_PROJECT_DIR = '/home/user/my-project/'
  expect(ownerName()).toBe('my-project')
})

test('ownerName: CLAUDE_PROJECT_DIR 未設定なら空文字を返す', () => {
  delete process.env.CLAUDE_PROJECT_DIR
  expect(ownerName()).toBe('')
})

// --- channelId のテスト ---

test('channelId: routes に書き込み済みなら値を返す', () => {
  process.env.CLAUDE_PROJECT_DIR = '/projects/cc-discord'
  writeRoute('cc-discord', '987654321')
  expect(channelId()).toBe('987654321')
})

test('channelId: routes 未解決なら null を返す', () => {
  process.env.CLAUDE_PROJECT_DIR = '/projects/no-route-project'
  expect(channelId()).toBeNull()
})

test('channelId: ownerName が空の場合は null を返す', () => {
  delete process.env.CLAUDE_PROJECT_DIR
  expect(channelId()).toBeNull()
})

// --- progressChannelId のテスト ---

test('progressChannelId: progress-thread/<owner> ファイルがあればその値を返す', () => {
  process.env.CLAUDE_PROJECT_DIR = '/projects/cc-discord'
  writeRoute('cc-discord', '111111111')
  const threadDir = join(process.env.DISCORD_STATE_DIR!, 'progress-thread')
  mkdirSync(threadDir, { recursive: true })
  writeFileSync(join(threadDir, 'cc-discord'), '222222222', { encoding: 'utf8' })
  expect(progressChannelId()).toBe('222222222')
})

test('progressChannelId: progress-thread ファイルが無ければ channelId にフォールバックする', () => {
  process.env.CLAUDE_PROJECT_DIR = '/projects/cc-discord'
  writeRoute('cc-discord', '111111111')
  expect(progressChannelId()).toBe('111111111')
})

test('progressChannelId: progress-thread ファイルが空白のみなら channelId にフォールバックする', () => {
  process.env.CLAUDE_PROJECT_DIR = '/projects/cc-discord'
  writeRoute('cc-discord', '111111111')
  const threadDir = join(process.env.DISCORD_STATE_DIR!, 'progress-thread')
  mkdirSync(threadDir, { recursive: true })
  writeFileSync(join(threadDir, 'cc-discord'), '   \n  ', { encoding: 'utf8' })
  expect(progressChannelId()).toBe('111111111')
})

test('progressChannelId: channelId も未解決なら null を返す', () => {
  process.env.CLAUDE_PROJECT_DIR = '/projects/no-route-project'
  expect(progressChannelId()).toBeNull()
})
