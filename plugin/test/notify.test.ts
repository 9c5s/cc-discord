import { test, expect, beforeEach, afterEach } from 'bun:test'
import { writeRoute } from '../src/routes'
import { ownerName, channelId, progressChannelId, sendNow } from '../src/notify'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// テスト用の一時ディレクトリを設定して 本番 state を保護する
// routes.test.ts と同じパターンを踏襲する
const testTmpDir = join(tmpdir(), `discord-notify-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`)

// 各テストの実行前後で環境変数を正確に復元するためにバックアップを保持する
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

// --- sendNow の送信契約のテスト (fetch を差し替えて検証する) ---

// 宛先とトークンを設定し fetch を記録用モックに差し替えて fn を実行する
async function withMockedFetch(
  responses: Response[],
  fn: () => Promise<void>,
): Promise<{ url: string; init: RequestInit }[]> {
  process.env.CLAUDE_PROJECT_DIR = '/projects/cc-discord'
  process.env.DISCORD_BOT_TOKEN = 'test-token'
  writeRoute('cc-discord', '123456789')
  const calls: { url: string; init: RequestInit }[] = []
  const orig = globalThis.fetch
  let i = 0
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return responses[Math.min(i++, responses.length - 1)].clone()
  }) as typeof fetch
  try {
    await fn()
  } finally {
    globalThis.fetch = orig
    delete process.env.DISCORD_BOT_TOKEN
  }
  return calls
}

test('sendNow: allowed_mentions 無効化と SUPPRESS_NOTIFICATIONS フラグを付けて送信する', async () => {
  const calls = await withMockedFetch([new Response('{}', { status: 200 })], async () => {
    await sendNow('hello')
  })
  expect(calls.length).toBe(1)
  expect(calls[0].url).toBe('https://discord.com/api/v10/channels/123456789/messages')
  const body = JSON.parse(String(calls[0].init.body))
  expect(body.content).toBe('hello')
  expect(body.allowed_mentions).toEqual({ parse: [] })
  expect(body.flags).toBe(4096)
})

test('sendNow: 429 のとき retry_after を待って1回だけ再送する', async () => {
  const tooMany = new Response('{"retry_after": 0.01}', { status: 429 })
  const ok = new Response('{}', { status: 200 })
  const calls = await withMockedFetch([tooMany, ok], async () => {
    await sendNow('retry me')
  })
  expect(calls.length).toBe(2)
  expect(JSON.parse(String(calls[1].init.body)).content).toBe('retry me')
})

test('sendNow: 1900 文字を超える本文は切り捨てサロゲートペアを分断しない', async () => {
  const text = 'a'.repeat(1899) + '😀😀'
  const calls = await withMockedFetch([new Response('{}', { status: 200 })], async () => {
    await sendNow(text)
  })
  const content = JSON.parse(String(calls[0].init.body)).content as string
  // 1900 文字目が絵文字の上位サロゲートに当たるため 1 文字余分に落ちて 1899 文字になる
  expect(content).toBe('a'.repeat(1899))
})
