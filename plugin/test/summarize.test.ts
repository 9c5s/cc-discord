import { test, expect } from 'bun:test'
import { toolSummary, thinkingGist } from '../src/summarize'

test('toolSummary は絵文字も含めて file_path をインラインコードにする', () => {
  expect(toolSummary('Read', { file_path: 'C:/x/server.ts' })).toBe('`🔧 Read server.ts`')
})

test('toolSummary は pattern をインラインコードにする', () => {
  expect(toolSummary('Grep', { pattern: 'foo.*bar' })).toBe('`🔧 Grep: foo.*bar`')
})

test('toolSummary は bash をツール名と本文の間で改行しコードブロックにする', () => {
  expect(toolSummary('Bash', { command: 'bun test' })).toBe('```\n🔧 Bash\nbun test\n```')
})

test('toolSummary は bash の内容を省略しない', () => {
  const long = 'echo ' + 'x'.repeat(200)
  expect(toolSummary('Bash', { command: long })).toBe('```\n🔧 Bash\n' + long + '\n```')
})

test('toolSummary は引数が無ければツール名のみにする', () => {
  expect(toolSummary('Glob', {})).toBe('`🔧 Glob`')
})

test('toolSummary は hideBody が true なら本文を出さずツール名のみにする', () => {
  expect(toolSummary('Bash', { command: 'bun test' }, true)).toBe('`🔧 Bash`')
  expect(toolSummary('Read', { file_path: 'x/server.ts' }, true)).toBe('`🔧 Read`')
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
