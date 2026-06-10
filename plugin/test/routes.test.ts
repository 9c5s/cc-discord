import { test, expect, beforeEach, afterEach } from 'bun:test'
import { writeRoute, readRoute, routesDir, stateDir } from '../src/routes'
import { rmSync, existsSync } from 'fs'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'

// テスト用の一時ディレクトリを設定して 本番 routes を保護する
const testTmpDir = join(tmpdir(), `discord-routes-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`)

beforeEach(() => {
  // テスト実行前に環境変数を設定
  process.env.DISCORD_STATE_DIR = join(testTmpDir, 'state')
  // 初期化時に一時ディレクトリが作成される
  mkdirSync(process.env.DISCORD_STATE_DIR, { recursive: true })
})

afterEach(() => {
  // テスト後にクリーンアップ
  if (existsSync(testTmpDir)) {
    rmSync(testTmpDir, { recursive: true, force: true })
  }
  delete process.env.DISCORD_STATE_DIR
})

test('書き込んだ値を読み出せる', () => {
  writeRoute('cc-discord', '123456789')
  expect(readRoute('cc-discord')).toBe('123456789')
})

test('存在しないキーは null を返す', () => {
  expect(readRoute('nope')).toBeNull()
})

test('routesDir は stateDir/routes を返す', () => {
  expect(routesDir()).toBe(join(process.env.DISCORD_STATE_DIR!, 'routes'))
})

test('空白のみの値は null を返す', () => {
  writeRoute('blank', '   ')
  expect(readRoute('blank')).toBeNull()
})

test('readRoute は不正な名前(..)に対して null を返す', () => {
  expect(readRoute('../escape')).toBeNull()
})

test('readRoute は空文字に対して null を返す', () => {
  expect(readRoute('')).toBeNull()
})

test('writeRoute は不正な名前(..)に対して throw する', () => {
  expect(() => writeRoute('../escape', 'x')).toThrow()
})

test('writeRoute は大文字を含む名前に対して throw する', () => {
  expect(() => writeRoute('UPPER', 'x')).toThrow()
})

test('stateDir は DISCORD_STATE_DIR 未設定時に homedir/.claude/channels/discord を返す', () => {
  const savedEnv = process.env.DISCORD_STATE_DIR
  try {
    delete process.env.DISCORD_STATE_DIR
    expect(stateDir()).toBe(join(homedir(), '.claude', 'channels', 'discord'))
  } finally {
    process.env.DISCORD_STATE_DIR = savedEnv
  }
})
