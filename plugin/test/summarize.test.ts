import { test, expect } from 'bun:test'
import { toolSummary, thinkingGist, threadName } from '../src/summarize'

test('toolSummary は絵文字も含めて file_path をインラインコードにする', () => {
  expect(toolSummary('Read', { file_path: 'C:/x/server.ts' })).toBe('`⚙️ Read server.ts`')
})

test('toolSummary は pattern をインラインコードにする', () => {
  expect(toolSummary('Grep', { pattern: 'foo.*bar' })).toBe('`⚙️ Grep: foo.*bar`')
})

test('toolSummary は bash をツール名と本文の間で改行しコードブロックにする', () => {
  expect(toolSummary('Bash', { command: 'bun test' })).toBe('```\n⚙️ Bash\nbun test\n```')
})

test('toolSummary は bash の内容を省略しない', () => {
  const long = 'echo ' + 'x'.repeat(200)
  expect(toolSummary('Bash', { command: long })).toBe('```\n⚙️ Bash\n' + long + '\n```')
})

test('toolSummary は引数が無ければツール名のみにする', () => {
  expect(toolSummary('Glob', {})).toBe('`⚙️ Glob`')
})

test('toolSummary は hideBody が true なら本文を出さずツール名のみにする', () => {
  expect(toolSummary('Bash', { command: 'bun test' }, true)).toBe('`⚙️ Bash`')
  expect(toolSummary('Read', { file_path: 'x/server.ts' }, true)).toBe('`⚙️ Read`')
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

test('threadName は日時プレフィックスと本文でスレッド名を作る', () => {
  expect(threadName('再起動した', new Date(2026, 5, 1, 20, 13))).toBe('[06/01 20:13] 再起動した')
})

test('threadName は月日時分をゼロ埋めする', () => {
  expect(threadName('x', new Date(2026, 0, 5, 9, 3))).toBe('[01/05 09:03] x')
})

test('threadName は改行と連続空白を空白1つに正規化する', () => {
  expect(threadName('a\n\nb  c', new Date(2026, 5, 1, 20, 13))).toBe('[06/01 20:13] a b c')
})

test('threadName は80字ちょうどは切らない', () => {
  expect(threadName('あ'.repeat(80), new Date(2026, 5, 1, 20, 13))).toBe('[06/01 20:13] ' + 'あ'.repeat(80))
})

test('threadName は80字超の本文を79字と…に切り詰める', () => {
  expect(threadName('あ'.repeat(100), new Date(2026, 5, 1, 20, 13))).toBe('[06/01 20:13] ' + 'あ'.repeat(79) + '…')
})

test('threadName は本文が空白のみなら progress にする', () => {
  expect(threadName('', new Date(2026, 5, 1, 20, 13))).toBe('[06/01 20:13] progress')
  expect(threadName('   ', new Date(2026, 5, 1, 20, 13))).toBe('[06/01 20:13] progress')
})
