import { test, expect, beforeEach, afterEach } from 'bun:test'
import { ownerName } from '../src/notify'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// テスト用の一時ディレクトリを設定して 本番 state を保護する
// routes.test.ts と同じパターンを踏襲する
const testTmpDir = join(tmpdir(), `discord-notify-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`)

// 各テストの実行前後で環境変数を正確に復元するためにバックアップを保持する
let savedStateDir: string | undefined
let savedProjectDir: string | undefined
let savedOverrideDir: string | undefined

beforeEach(() => {
  savedStateDir = process.env.DISCORD_STATE_DIR
  savedProjectDir = process.env.CLAUDE_PROJECT_DIR
  savedOverrideDir = process.env.CC_DISCORD_PROJECT_DIR
  delete process.env.CC_DISCORD_PROJECT_DIR
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
  if (savedOverrideDir === undefined) {
    delete process.env.CC_DISCORD_PROJECT_DIR
  } else {
    process.env.CC_DISCORD_PROJECT_DIR = savedOverrideDir
  }
})

// --- ownerName のテスト ---

test('ownerName: CLAUDE_PROJECT_DIR 設定時にベース名を正規化して返す', () => {
  process.env.CLAUDE_PROJECT_DIR = 'C:\\example\\My Proj'
  expect(ownerName()).toBe('my-proj')
})

test('ownerName: 末尾セパレータ付きでも同じ名前を返す', () => {
  process.env.CLAUDE_PROJECT_DIR = 'C:\\example\\My Proj\\'
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

test('ownerName: CC_DISCORD_PROJECT_DIR があれば CLAUDE_PROJECT_DIR より優先する', () => {
  process.env.CLAUDE_PROJECT_DIR = 'C:\\example\\spike'
  process.env.CC_DISCORD_PROJECT_DIR = 'C:\\example\\eagle'
  expect(ownerName()).toBe('eagle')
})

test('ownerName: 正規化名が空になるディレクトリでは空文字を返す', () => {
  process.env.CLAUDE_PROJECT_DIR = 'C:\\example\\---'
  expect(ownerName()).toBe('')
})
