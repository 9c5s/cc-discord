import { test, expect } from 'bun:test'
import { toolSummary, thinkingGist, threadName } from '../src/summarize'

test('toolSummary は絵文字も含めて file_path をインラインコードにする', () => {
  expect(toolSummary('Read', { file_path: 'C:/x/server.ts' })).toBe('`⚙️ [Read] server.ts`')
})

test('toolSummary は pattern をインラインコードにする', () => {
  expect(toolSummary('Grep', { pattern: 'foo.*bar' })).toBe('`⚙️ [Grep] foo.*bar`')
})

test('toolSummary は bash をツール名と本文の間で改行しコードブロックにする', () => {
  expect(toolSummary('Bash', { command: 'bun test' })).toBe('```\n⚙️ [Bash]\nbun test\n```')
})

test('toolSummary は100字を超える bash を100字で切り捨て…を付ける', () => {
  const long = 'echo ' + 'x'.repeat(200)
  expect(toolSummary('Bash', { command: long })).toBe('```\n⚙️ [Bash]\n' + long.slice(0, 100) + '…\n```')
})

test('toolSummary は引数が無ければツール名のみにする', () => {
  expect(toolSummary('Glob', {})).toBe('`⚙️ [Glob]`')
})

test('toolSummary は pattern を path より優先する', () => {
  expect(toolSummary('Grep', { pattern: 'foo.*bar', path: 'D:/x/src' })).toBe('`⚙️ [Grep] foo.*bar`')
})

test('toolSummary は path のみなら値をそのまま示す', () => {
  expect(toolSummary('LS', { path: 'D:/x/src' })).toBe('`⚙️ [LS] D:/x/src`')
})

test('toolSummary は scriptPath をファイル名のみ示す', () => {
  expect(toolSummary('Workflow', { scriptPath: 'C:/x/wf-review.mjs' })).toBe('`⚙️ [Workflow] wf-review.mjs`')
})

test('toolSummary は description を prompt より優先しインラインにする', () => {
  expect(toolSummary('Agent', { description: 'ログ調査', prompt: 'x'.repeat(200) })).toBe('`⚙️ [Agent] ログ調査`')
})

test('toolSummary は skill 名を示す', () => {
  expect(toolSummary('Skill', { skill: 'commit', args: '-m foo' })).toBe('`⚙️ [Skill] commit`')
})

test('toolSummary は query を示す', () => {
  expect(toolSummary('WebSearch', { query: 'bun mock' })).toBe('`⚙️ [WebSearch] bun mock`')
})

test('toolSummary は url を prompt より優先する', () => {
  expect(toolSummary('WebFetch', { url: 'https://example.com', prompt: 'タイトルを抽出' })).toBe('`⚙️ [WebFetch] https://example.com`')
})

test('toolSummary は100字を超える本文を100字で切り捨て bash と同じ形式にする', () => {
  expect(toolSummary('Agent', { prompt: 'あ'.repeat(150) })).toBe('```\n⚙️ [Agent]\n' + 'あ'.repeat(100) + '…\n```')
})

test('toolSummary は100字ちょうどの本文を切らずインラインにする', () => {
  expect(toolSummary('Agent', { prompt: 'a'.repeat(100) })).toBe('`⚙️ [Agent] ' + 'a'.repeat(100) + '`')
})

test('toolSummary はサロゲートペアを分断せず100文字で切る', () => {
  expect(toolSummary('Agent', { prompt: '😀'.repeat(101) })).toBe('```\n⚙️ [Agent]\n' + '😀'.repeat(100) + '…\n```')
})

test('toolSummary は改行を含む本文を bash と同じ形式にする', () => {
  expect(toolSummary('Reply', { text: 'a\nb' })).toBe('```\n⚙️ [Reply]\na\nb\n```')
})

test('toolSummary は空白のみの値をスキップして次の候補を拾う', () => {
  expect(toolSummary('Skill', { description: '  ', skill: 'commit' })).toBe('`⚙️ [Skill] commit`')
})

test('toolSummary は files をファイル名の一覧にする', () => {
  expect(toolSummary('SendUserFile', { files: ['D:\\x\\report.png', '/tmp/log.txt'] })).toBe('`⚙️ [SendUserFile] report.png, log.txt`')
})

test('toolSummary は questions の先頭の質問文を示す', () => {
  expect(toolSummary('AskUserQuestion', { questions: [{ question: '認証方式は?' }] })).toBe('`⚙️ [AskUserQuestion] 認証方式は?`')
})

test('toolSummary は todos の進行中項目を示す', () => {
  const todos = [
    { content: 'a', status: 'completed', activeForm: 'A中' },
    { content: 'b', status: 'in_progress', activeForm: 'B中' },
  ]
  expect(toolSummary('TodoWrite', { todos })).toBe('`⚙️ [TodoWrite] B中`')
})

test('toolSummary は進行中の無い todos を件数にする', () => {
  expect(toolSummary('TodoWrite', { todos: [{ status: 'pending' }, { status: 'pending' }] })).toBe('`⚙️ [TodoWrite] 2件`')
})

test('toolSummary は hideBody が true なら本文を出さずツール名のみにする', () => {
  expect(toolSummary('Bash', { command: 'bun test' }, true)).toBe('`⚙️ [Bash]`')
  expect(toolSummary('Read', { file_path: 'x/server.ts' }, true)).toBe('`⚙️ [Read]`')
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
