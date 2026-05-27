import { test, expect, beforeEach, afterEach } from 'bun:test'
import { writeRoute, readRoute, routesDir } from './routes'
import { rmSync, existsSync } from 'fs'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// テスト用の一時ディレクトリを設定して、本番 routes を保護する
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

test('write then read returns channel id', () => {
  writeRoute('cc-discord', '123456789')
  expect(readRoute('cc-discord')).toBe('123456789')
})

test('read missing returns null', () => {
  expect(readRoute('nope')).toBeNull()
})
