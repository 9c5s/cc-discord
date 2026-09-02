import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  buildFooter,
  contextWindow,
  modelDisplayName,
  readLastAssistantEntry,
  readTranscriptTail,
} from '../src/footer'

const testTmpDir = join(tmpdir(), `discord-footer-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`)
let savedConfigDir: string | undefined
let savedEffort: string | undefined

beforeEach(() => {
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  savedEffort = process.env.CLAUDE_EFFORT
  delete process.env.CLAUDE_EFFORT
  process.env.CLAUDE_CONFIG_DIR = join(testTmpDir, 'config')
  mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(testTmpDir, { recursive: true, force: true })
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  if (savedEffort === undefined) delete process.env.CLAUDE_EFFORT
  else process.env.CLAUDE_EFFORT = savedEffort
})

function tmpFile(name: string, content: string): string {
  const p = join(testTmpDir, name)
  mkdirSync(testTmpDir, { recursive: true })
  writeFileSync(p, content)
  return p
}

function assistantLine(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    effort: 'high',
    message: {
      model: 'claude-opus-5',
      usage: { input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 700 },
    },
    ...over,
  })
}

// --- readTranscriptTail ---

test('readTranscriptTail は上限より小さいファイルを丸ごと読む', () => {
  const p = tmpFile('t.jsonl', 'a\nb\n')
  expect(readTranscriptTail(p, 1024)).toBe('a\nb\n')
})

test('readTranscriptTail は上限を超えるファイルの先頭の不完全な行を捨てる', () => {
  const p = tmpFile('t.jsonl', 'first-line-is-long\nsecond\nthird\n')
  // 末尾 16 バイトは "ng\nsecond\nthird\n" で 先頭の "ng" は切れた行なので捨てる
  expect(readTranscriptTail(p, 16)).toBe('second\nthird\n')
})

test('readTranscriptTail は改行を含まない末尾では空を返す', () => {
  const p = tmpFile('t.jsonl', 'aaaaaaaaaaaaaaaaaaaa')
  expect(readTranscriptTail(p, 5)).toBe('')
})

test('readTranscriptTail は読めないファイルで null を返す', () => {
  expect(readTranscriptTail(join(testTmpDir, 'absent.jsonl'), 1024)).toBe(null)
})

// --- readLastAssistantEntry ---

test('readLastAssistantEntry は最後の assistant エントリから model と effort と usage を取る', () => {
  const p = tmpFile('t.jsonl', `${assistantLine()}\n`)
  expect(readLastAssistantEntry(p)).toEqual({
    model: 'claude-opus-5',
    effort: 'high',
    tokens: 1000,
  })
})

test('readLastAssistantEntry は後ろから走査して最初の該当を返す', () => {
  const older = assistantLine({ message: { model: 'claude-opus-5', usage: { input_tokens: 1 } } })
  const newer = assistantLine({ message: { model: 'claude-fable-5-1', usage: { input_tokens: 5 } } })
  const p = tmpFile('t.jsonl', `${older}\n${newer}\n`)
  expect(readLastAssistantEntry(p)?.model).toBe('claude-fable-5-1')
})

test('readLastAssistantEntry は synthetic のエントリを飛ばす', () => {
  const synthetic = assistantLine({ message: { model: '<synthetic>', usage: { input_tokens: 1 } } })
  const p = tmpFile('t.jsonl', `${assistantLine()}\n${synthetic}\n`)
  expect(readLastAssistantEntry(p)?.model).toBe('claude-opus-5')
})

test('readLastAssistantEntry は usage を持たないエントリを飛ばす', () => {
  const noUsage = assistantLine({ message: { model: 'claude-fable-5-1' } })
  const p = tmpFile('t.jsonl', `${assistantLine()}\n${noUsage}\n`)
  expect(readLastAssistantEntry(p)?.model).toBe('claude-opus-5')
})

test('readLastAssistantEntry は assistant 以外のエントリを飛ばす', () => {
  const user = JSON.stringify({ type: 'user', message: { model: 'claude-fable-5-1', usage: { input_tokens: 1 } } })
  const p = tmpFile('t.jsonl', `${assistantLine()}\n${user}\n`)
  expect(readLastAssistantEntry(p)?.model).toBe('claude-opus-5')
})

test('readLastAssistantEntry は解析できない行を飛ばす', () => {
  const p = tmpFile('t.jsonl', `${assistantLine()}\n{ broken\n`)
  expect(readLastAssistantEntry(p)?.model).toBe('claude-opus-5')
})

test('readLastAssistantEntry は該当が無ければ null を返す', () => {
  const p = tmpFile('t.jsonl', '{"type":"user"}\n')
  expect(readLastAssistantEntry(p)).toBe(null)
})

test('readLastAssistantEntry は effort が無いエントリで effort を null にする', () => {
  const p = tmpFile('t.jsonl', `${assistantLine({ effort: undefined })}\n`)
  expect(readLastAssistantEntry(p)?.effort).toBe(null)
})

// --- modelDisplayName ---

test('modelDisplayName は family と major.minor を表示名にする', () => {
  expect(modelDisplayName('claude-fable-5-1')).toBe('Fable 5.1')
  expect(modelDisplayName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
})

test('modelDisplayName は minor が無ければ major だけにする', () => {
  expect(modelDisplayName('claude-opus-5')).toBe('Opus 5')
})

test('modelDisplayName は規約外の id をそのまま使う', () => {
  expect(modelDisplayName('gpt-9')).toBe('gpt-9')
})

// --- contextWindow ---

function writeSettings(dir: string, name: string, model: unknown): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), JSON.stringify(model === undefined ? {} : { model }))
}

test('contextWindow は model に [1m] があれば 1M を返す', () => {
  const ownerDir = join(testTmpDir, 'proj')
  writeSettings(join(ownerDir, '.claude'), 'settings.json', 'opus[1m]')
  expect(contextWindow(ownerDir)).toBe(1_000_000)
})

test('contextWindow は model に [1m] が無ければ 200K を返す', () => {
  const ownerDir = join(testTmpDir, 'proj')
  writeSettings(join(ownerDir, '.claude'), 'settings.json', 'opus')
  expect(contextWindow(ownerDir)).toBe(200_000)
})

test('contextWindow は local を project より優先する', () => {
  const ownerDir = join(testTmpDir, 'proj')
  writeSettings(join(ownerDir, '.claude'), 'settings.local.json', 'sonnet')
  writeSettings(join(ownerDir, '.claude'), 'settings.json', 'opus[1m]')
  expect(contextWindow(ownerDir)).toBe(200_000)
})

test('contextWindow は project を user より優先する', () => {
  const ownerDir = join(testTmpDir, 'proj')
  writeSettings(join(ownerDir, '.claude'), 'settings.json', 'sonnet')
  writeSettings(process.env.CLAUDE_CONFIG_DIR as string, 'settings.json', 'opus[1m]')
  expect(contextWindow(ownerDir)).toBe(200_000)
})

test('contextWindow は model を持たない設定を飛ばして次を見る', () => {
  const ownerDir = join(testTmpDir, 'proj')
  writeSettings(join(ownerDir, '.claude'), 'settings.local.json', undefined)
  writeSettings(process.env.CLAUDE_CONFIG_DIR as string, 'settings.json', 'opus[1m]')
  expect(contextWindow(ownerDir)).toBe(1_000_000)
})

test('contextWindow は設定が無ければ 200K を返す', () => {
  expect(contextWindow(join(testTmpDir, 'absent'))).toBe(200_000)
})

// --- buildFooter ---

const USAGE = {
  weekly: { used_percentage: 51, resets_at: 1787454000 },
  session: { used_percentage: 63, resets_at: 1787464800 },
  modelScoped: [{ display_name: 'Fable', percent: 88, resets_at: null }],
}

test('buildFooter はモデルと ctx と 5h と 7d を含むブロックを作る', () => {
  const ownerDir = join(testTmpDir, 'proj')
  writeSettings(join(ownerDir, '.claude'), 'settings.json', 'opus[1m]')
  const p = tmpFile('t.jsonl', `${assistantLine()}\n`)
  const footer = buildFooter({ transcriptPath: p, ownerDir, usage: USAGE })
  // 1M かどうかは ctx% の分母にだけ効かせ 表示名には出さない
  expect(footer).toContain('👾 Opus 5 | 🧠 high')
  // 1000 / 1_000_000 = 0.1% -> 切り捨てて 0%
  expect(footer).toContain('📊 0%')
  expect(footer).toContain('⏰ 63%')
  expect(footer).toContain('📅 51%(88%)')
})

test('buildFooter は ctx% を切り捨てで計算する', () => {
  const ownerDir = join(testTmpDir, 'proj')
  const line = assistantLine({
    message: {
      model: 'claude-opus-5',
      usage: { input_tokens: 100_000, cache_creation_input_tokens: 50_000, cache_read_input_tokens: 9_999 },
    },
  })
  const p = tmpFile('t.jsonl', `${line}\n`)
  // 159999 / 200000 = 79.99% -> 79%
  expect(buildFooter({ transcriptPath: p, ownerDir, usage: USAGE })).toContain('📊 79%')
})

test('buildFooter は transcript が無ければモデル行と ctx を省く', () => {
  const ownerDir = join(testTmpDir, 'proj')
  const footer = buildFooter({ transcriptPath: null, ownerDir, usage: USAGE })
  expect(footer).not.toContain('👾')
  expect(footer).not.toContain('📊')
  expect(footer).toContain('⏰ 63%')
})

test('buildFooter は effort が transcript に無ければ CLAUDE_EFFORT を使う', () => {
  const ownerDir = join(testTmpDir, 'proj')
  process.env.CLAUDE_EFFORT = 'medium'
  const p = tmpFile('t.jsonl', `${assistantLine({ effort: undefined })}\n`)
  expect(buildFooter({ transcriptPath: p, ownerDir, usage: USAGE })).toContain('🧠 medium')
})

test('buildFooter は使用量が無く transcript も無ければ空文字を返す', () => {
  expect(buildFooter({
    transcriptPath: null,
    ownerDir: null,
    usage: { weekly: null, session: null, modelScoped: [] },
  })).toBe('')
})
