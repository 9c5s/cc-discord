import { test, expect } from 'bun:test'
import { checkDescription } from '../src/description-ja'

test('checkDescription は日本語の description を許可する', () => {
  expect(checkDescription('Bash', { command: 'ls', description: 'ファイル一覧を表示' })).toBeNull()
})

test('checkDescription はカタカナのみの description を許可する', () => {
  expect(checkDescription('Bash', { command: 'bun test', description: 'テスト' })).toBeNull()
})

test('checkDescription は技術用語混じりの日本語を許可する', () => {
  expect(checkDescription('PowerShell', { command: 'gh pr view 1', description: 'PR #1 を確認' })).toBeNull()
})

test('checkDescription は英語のみの description を拒否する', () => {
  const reason = checkDescription('Bash', { command: 'ls', description: 'List files' })
  expect(reason).toContain('日本語で書き直す')
  expect(reason).toContain('List files')
})

test('checkDescription は日本語の約物だけを含む英文を拒否する', () => {
  expect(checkDescription('Bash', { command: 'ls', description: 'List files ・' })).toContain(
    '日本語で書き直す',
  )
  expect(checkDescription('Bash', { command: 'ls', description: 'APIーCLI bridge' })).toContain(
    '日本語で書き直す',
  )
})

test('checkDescription は Bash の description 欠落を拒否する', () => {
  expect(checkDescription('Bash', { command: 'ls' })).toContain('日本語のコマンド説明')
})

test('checkDescription は PowerShell の空白のみの description を欠落として拒否する', () => {
  expect(checkDescription('PowerShell', { command: 'ls', description: '  ' })).toContain(
    '日本語のコマンド説明',
  )
})

test('checkDescription は Bash 以外の description 欠落を許可する', () => {
  expect(checkDescription('Read', { file_path: 'x.ts' })).toBeNull()
})

test('checkDescription は Bash 以外でも英語の description は拒否する', () => {
  expect(checkDescription('Agent', { prompt: 'x', description: 'Investigate logs' })).toContain(
    '日本語で書き直す',
  )
})

test('checkDescription は tool_input が無くても異常終了しない', () => {
  expect(checkDescription('Read', undefined)).toBeNull()
  expect(checkDescription(undefined, null)).toBeNull()
})
