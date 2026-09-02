import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createAccessReader, isAllowedTarget, readAccess } from '../src/access'

// テスト用の一時 state ディレクトリを使い 本番 state を保護する
const testTmpDir = join(tmpdir(), `discord-access-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`)
let savedStateDir: string | undefined
let savedMode: string | undefined

beforeEach(() => {
  savedStateDir = process.env.DISCORD_STATE_DIR
  savedMode = process.env.DISCORD_ACCESS_MODE
  delete process.env.DISCORD_ACCESS_MODE
  process.env.DISCORD_STATE_DIR = join(testTmpDir, 'state')
  mkdirSync(process.env.DISCORD_STATE_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(testTmpDir, { recursive: true, force: true })
  if (savedStateDir === undefined) delete process.env.DISCORD_STATE_DIR
  else process.env.DISCORD_STATE_DIR = savedStateDir
  if (savedMode === undefined) delete process.env.DISCORD_ACCESS_MODE
  else process.env.DISCORD_ACCESS_MODE = savedMode
})

function writeAccess(content: string): string {
  const f = join(process.env.DISCORD_STATE_DIR as string, 'access.json')
  writeFileSync(f, content)
  return f
}

// --- readAccess ---

test('readAccess はファイルが無ければ既定値を返す', () => {
  expect(readAccess()).toEqual({ allowFrom: [], groups: {} })
})

test('readAccess は allowFrom と groups と送信設定を読む', () => {
  writeAccess(JSON.stringify({
    dmPolicy: 'allowlist',
    allowFrom: ['258152380355444736'],
    groups: { '33333333333333333': { requireMention: false, allowFrom: [] } },
    replyToMode: 'off',
    textChunkLimit: 1800,
    chunkMode: 'newline',
    pending: {},
  }))
  expect(readAccess()).toEqual({
    allowFrom: ['258152380355444736'],
    groups: { '33333333333333333': { requireMention: false, allowFrom: [] } },
    replyToMode: 'off',
    textChunkLimit: 1800,
    chunkMode: 'newline',
  })
})

test('readAccess は解析できないファイルで既定値を返し ファイルを退避しない', () => {
  const f = writeAccess('{ broken')
  expect(readAccess()).toEqual({ allowFrom: [], groups: {} })
  // 退避 (.corrupt-<ts> へのリネーム) は公式 server の役割であり proxy は触らない
  expect(readdirSync(process.env.DISCORD_STATE_DIR as string)).toEqual(['access.json'])
  expect(f).toContain('access.json')
})

test('readAccess は allowFrom や groups が欠けたファイルで既定値を補う', () => {
  writeAccess(JSON.stringify({ dmPolicy: 'allowlist' }))
  expect(readAccess()).toEqual({ allowFrom: [], groups: {} })
})

// --- createAccessReader ---

test('createAccessReader は static モードで起動時の内容を固定する', () => {
  writeAccess(JSON.stringify({ allowFrom: ['1'], groups: {} }))
  process.env.DISCORD_ACCESS_MODE = 'static'
  const read = createAccessReader()
  writeAccess(JSON.stringify({ allowFrom: ['2'], groups: {} }))
  expect(read().allowFrom).toEqual(['1'])
})

test('createAccessReader は static モード以外では毎回読み直す', () => {
  writeAccess(JSON.stringify({ allowFrom: ['1'], groups: {} }))
  const read = createAccessReader()
  writeAccess(JSON.stringify({ allowFrom: ['2'], groups: {} }))
  expect(read().allowFrom).toEqual(['2'])
})

// --- isAllowedTarget ---

const USER = '258152380355444736'
const DM_CH = '77777777777777777'
const GROUP_CH = '33333333333333333'
const THREAD_CH = '44444444444444444'
const access = { allowFrom: [USER], groups: { [GROUP_CH]: {} } }

test('isAllowedTarget は allowFrom に含まれる相手との DM を許可する', () => {
  expect(isAllowedTarget(access, DM_CH, { id: DM_CH, type: 1, recipients: [{ id: USER }] })).toBe(true)
})

test('isAllowedTarget は allowFrom に無い相手との DM を拒否する', () => {
  expect(isAllowedTarget(access, DM_CH, { id: DM_CH, type: 1, recipients: [{ id: '999' }] })).toBe(false)
})

test('isAllowedTarget は recipients が欠けた DM を拒否する', () => {
  expect(isAllowedTarget(access, DM_CH, { id: DM_CH, type: 1 })).toBe(false)
  expect(isAllowedTarget(access, DM_CH, { id: DM_CH, type: 1, recipients: [] })).toBe(false)
})

test('isAllowedTarget は groups に含まれるチャンネルを許可する', () => {
  expect(isAllowedTarget(access, GROUP_CH, { id: GROUP_CH, type: 0 })).toBe(true)
})

test('isAllowedTarget は groups に無いチャンネルを拒否する', () => {
  expect(isAllowedTarget(access, '55555555555555555', { id: '55555555555555555', type: 0 })).toBe(false)
})

test('isAllowedTarget はスレッドを親チャンネルで判定する', () => {
  expect(isAllowedTarget(access, THREAD_CH, { id: THREAD_CH, type: 11, parent_id: GROUP_CH })).toBe(true)
  expect(isAllowedTarget(access, THREAD_CH, { id: THREAD_CH, type: 11, parent_id: '55555555555555555' })).toBe(false)
})

test('isAllowedTarget はカテゴリ配下の GuildText を親ではなく自身の id で判定する', () => {
  // GuildText の parent_id は所属カテゴリの id である
  // 親を見るのはスレッドのときだけで カテゴリで判定すると担当チャンネルへの送信まで拒否される
  expect(isAllowedTarget(access, GROUP_CH, { id: GROUP_CH, type: 0, parent_id: '88888888888888888' })).toBe(true)
})

test('isAllowedTarget は親を持たないスレッドを自身の id で判定する', () => {
  expect(isAllowedTarget(access, GROUP_CH, { id: GROUP_CH, type: 11 })).toBe(true)
  expect(isAllowedTarget(access, THREAD_CH, { id: THREAD_CH, type: 11 })).toBe(false)
})

test('isAllowedTarget は実体を取得できなければ拒否する', () => {
  expect(isAllowedTarget(access, GROUP_CH, null)).toBe(false)
})

test('isAllowedTarget は取得した実体の id が要求と一致しなければ拒否する', () => {
  expect(isAllowedTarget(access, GROUP_CH, { id: '55555555555555555', type: 0 })).toBe(false)
})

// --- 送信設定の検証 ---

test('readAccess は数値でない textChunkLimit を採用しない', () => {
  writeAccess(JSON.stringify({ allowFrom: [], groups: {}, textChunkLimit: '500' }))
  expect(readAccess().textChunkLimit).toBeUndefined()
})

test('readAccess は有限でない textChunkLimit を採用しない', () => {
  writeAccess('{"allowFrom":[],"groups":{},"textChunkLimit":1e999}')
  expect(readAccess().textChunkLimit).toBeUndefined()
})

test('readAccess は既知でない replyToMode を採用しない', () => {
  writeAccess(JSON.stringify({ allowFrom: [], groups: {}, replyToMode: 'sometimes' }))
  expect(readAccess().replyToMode).toBeUndefined()
})

test('readAccess は既知でない chunkMode を採用しない', () => {
  writeAccess(JSON.stringify({ allowFrom: [], groups: {}, chunkMode: 'smart' }))
  expect(readAccess().chunkMode).toBeUndefined()
})

test('readAccess は既知の送信設定をそのまま採用する', () => {
  writeAccess(JSON.stringify({ allowFrom: [], groups: {}, replyToMode: 'all', chunkMode: 'newline', textChunkLimit: 500 }))
  const a = readAccess()
  expect(a.replyToMode).toBe('all')
  expect(a.chunkMode).toBe('newline')
  expect(a.textChunkLimit).toBe(500)
})

test('readAccess は allowFrom の文字列でない要素を落とす', () => {
  writeAccess(JSON.stringify({ allowFrom: ['1', 2, null], groups: {} }))
  expect(readAccess().allowFrom).toEqual(['1'])
})
