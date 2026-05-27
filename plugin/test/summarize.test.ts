import { test, expect } from 'bun:test'
import { toolSummary, thinkingGist } from '../src/summarize'

test('toolSummary は1行の本文をインラインコードで表示する', () => {
  expect(toolSummary('Read', { file_path: 'C:/x/server.ts' })).toBe('🔧 Read `server.ts`')
  expect(toolSummary('Bash', { command: 'bun test' })).toBe('🔧 Bash: `bun test`')
})

test('toolSummary は複数行の本文をコードブロックで表示する', () => {
  expect(toolSummary('Bash', { command: 'cd foo\nbun test' })).toBe('🔧 Bash: \n```\ncd foo\nbun test\n```')
})

test('toolSummary は引数が無ければツール名のみにする', () => {
  expect(toolSummary('Glob', {})).toBe('🔧 Glob')
})

test('thinkingGist は先頭1-2文を要点として返す', () => {
  expect(thinkingGist('まず確認する。次に実装する。最後にテスト。')).toBe('🧠 まず確認する。次に実装する。')
})

test('thinkingGist は空入力で空文字を返す', () => {
  expect(thinkingGist('')).toBe('')
})

test('thinkingGist は長文を上限内に収める', () => {
  const g = thinkingGist('あ'.repeat(300))
  expect(g.startsWith('🧠 ')).toBe(true)
  expect(g.endsWith('…')).toBe(true)
  expect(g.length).toBeLessThanOrEqual(200)
})
