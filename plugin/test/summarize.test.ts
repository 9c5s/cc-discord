import { test, expect } from 'bun:test'
import { toolSummary, thinkingGist, threadName } from '../src/summarize'

test('toolSummary は絵文字も含めて file_path をインラインコードにする', () => {
  expect(toolSummary('Read', { file_path: 'C:/x/server.ts' })).toBe('`⚙️[Read] server.ts`')
})

test('toolSummary は極端に長いファイル名も200字で切り詰める', () => {
  const name = 'x'.repeat(250) + '.ts'
  expect(toolSummary('Read', { file_path: 'C:/work/' + name })).toBe('`⚙️[Read] ' + 'x'.repeat(200) + '…`')
})

test('toolSummary は pattern をインラインコードにする', () => {
  expect(toolSummary('Grep', { pattern: 'foo.*bar' })).toBe('`⚙️[Grep] foo.*bar`')
})

test('toolSummary は bash をツール名と本文の間で改行しコードブロックにする', () => {
  expect(toolSummary('Bash', { command: 'bun test' })).toBe('```\n⚙️[Bash]\nbun test\n```')
})

test('toolSummary は1800字を超える bash を1800字で切り捨て…を付ける', () => {
  const long = 'echo ' + 'x'.repeat(2000)
  expect(toolSummary('Bash', { command: long })).toBe('```\n⚙️[Bash]\n' + long.slice(0, 1800) + '…\n```')
})

test('toolSummary は1800字以下の bash を省略しない', () => {
  const long = 'echo ' + 'x'.repeat(495)
  expect(toolSummary('Bash', { command: long })).toBe('```\n⚙️[Bash]\n' + long + '\n```')
})

test('toolSummary は引数が無ければツール名のみにする', () => {
  expect(toolSummary('Glob', {})).toBe('`⚙️[Glob]`')
})

test('toolSummary は pattern を path より優先する', () => {
  expect(toolSummary('Grep', { pattern: 'foo.*bar', path: 'D:/x/src' })).toBe('`⚙️[Grep] foo.*bar`')
})

test('toolSummary は path のみなら値をそのまま示す', () => {
  expect(toolSummary('LS', { path: 'D:/x/src' })).toBe('`⚙️[LS] D:/x/src`')
})

test('toolSummary は scriptPath をファイル名のみ示す', () => {
  expect(toolSummary('Workflow', { scriptPath: 'C:/x/wf-review.mjs' })).toBe('`⚙️[Workflow] wf-review.mjs`')
})

test('toolSummary は description を prompt より優先しインラインにする', () => {
  expect(toolSummary('Agent', { description: 'ログ調査', prompt: 'x'.repeat(200) })).toBe('`⚙️[Agent] ログ調査`')
})

test('toolSummary は skill 名を示す', () => {
  expect(toolSummary('Skill', { skill: 'commit', args: '-m foo' })).toBe('`⚙️[Skill] commit`')
})

test('toolSummary は query を示す', () => {
  expect(toolSummary('WebSearch', { query: 'bun mock' })).toBe('`⚙️[WebSearch] bun mock`')
})

test('toolSummary は url を prompt より優先する', () => {
  expect(toolSummary('WebFetch', { url: 'https://example.com', prompt: 'タイトルを抽出' })).toBe('`⚙️[WebFetch] https://example.com`')
})

test('toolSummary は200字を超える本文を200字で切り捨て bash と同じ形式にする', () => {
  expect(toolSummary('Agent', { prompt: 'あ'.repeat(250) })).toBe('```\n⚙️[Agent]\n' + 'あ'.repeat(200) + '…\n```')
})

test('toolSummary は200字ちょうどの本文を切らずインラインにする', () => {
  expect(toolSummary('Agent', { prompt: 'a'.repeat(200) })).toBe('`⚙️[Agent] ' + 'a'.repeat(200) + '`')
})

test('toolSummary はサロゲートペアを分断せず200文字で切る', () => {
  expect(toolSummary('Agent', { prompt: '😀'.repeat(201) })).toBe('```\n⚙️[Agent]\n' + '😀'.repeat(200) + '…\n```')
})

test('toolSummary は改行を含む本文を bash と同じ形式にする', () => {
  expect(toolSummary('Reply', { text: 'a\nb' })).toBe('```\n⚙️[Reply]\na\nb\n```')
})

test('toolSummary は空白のみの値をスキップして次の候補を拾う', () => {
  expect(toolSummary('Skill', { description: '  ', skill: 'commit' })).toBe('`⚙️[Skill] commit`')
})

test('toolSummary は files をファイル名の一覧にする', () => {
  expect(toolSummary('SendUserFile', { files: ['D:\\x\\report.png', '/tmp/log.txt'] })).toBe('`⚙️[SendUserFile] report.png, log.txt`')
})

test('toolSummary は questions の先頭の質問文を示す', () => {
  expect(toolSummary('AskUserQuestion', { questions: [{ question: '認証方式は?' }] })).toBe('`⚙️[AskUserQuestion] 認証方式は?`')
})

test('toolSummary は todos の進行中項目を示す', () => {
  const todos = [
    { content: 'a', status: 'completed', activeForm: 'A中' },
    { content: 'b', status: 'in_progress', activeForm: 'B中' },
  ]
  expect(toolSummary('TodoWrite', { todos })).toBe('`⚙️[TodoWrite] B中`')
})

test('toolSummary は進行中の無い todos を件数にする', () => {
  expect(toolSummary('TodoWrite', { todos: [{ status: 'pending' }, { status: 'pending' }] })).toBe('`⚙️[TodoWrite] 2件`')
})

test('toolSummary は hideBody が true なら本文を出さずツール名のみにする', () => {
  expect(toolSummary('Bash', { command: 'bun test' }, true)).toBe('`⚙️[Bash]`')
  expect(toolSummary('Read', { file_path: 'x/server.ts' }, true)).toBe('`⚙️[Read]`')
})

test('toolSummary は mcp プラグインツール名を server:tool に短縮する', () => {
  expect(toolSummary('mcp__plugin_discord_discord__react', { emoji: '👍' })).toBe('`⚙️[discord:react] 👍`')
})

test('toolSummary は discord:reply の補足を出さずツール名のみにする', () => {
  expect(toolSummary('mcp__plugin_discord_discord__reply', { chat_id: '1', text: '了解' })).toBe('`⚙️[discord:reply]`')
})

test('toolSummary は claude_ai プレフィックスの mcp サーバー名を短縮する', () => {
  expect(toolSummary('mcp__claude_ai_Notion__notion-search', { query: '設計メモ' })).toBe('`⚙️[Notion:notion-search] 設計メモ`')
})

test('toolSummary はハイフン入り plugin の mcp サーバー名を短縮する', () => {
  expect(toolSummary('mcp__plugin_chrome-devtools-mcp_chrome-devtools__click', {})).toBe('`⚙️[chrome-devtools:click]`')
})

test('toolSummary は素の mcp サーバー名をそのまま使う', () => {
  expect(toolSummary('mcp__drawio__open_drawio_xml', {})).toBe('`⚙️[drawio:open_drawio_xml]`')
})

test('toolSummary はバッククォート密集で ZWSP 展開による超過を防ぐ', () => {
  const backquoteCommand = '```'.repeat(620)
  const result = toolSummary('Bash', { command: backquoteCommand })
  const resultPoints = [...result]
  expect(resultPoints.length).toBeLessThanOrEqual(1900)
  expect(result.endsWith('\n```')).toBe(true)
})

test('toolSummary はバッククォートを含む本文をコードブロックに逃がす', () => {
  expect(toolSummary('Grep', { pattern: 'foo`bar' })).toBe('```\n⚙️[Grep]\nfoo`bar\n```')
})

test('toolSummary は本文中の ``` をゼロ幅スペースで分断する', () => {
  const z = String.fromCharCode(0x200b)
  expect(toolSummary('Bash', { command: 'cat ```x```' })).toBe(`\`\`\`\n⚙️[Bash]\ncat \`${z}\`${z}\`x\`${z}\`${z}\`\n\`\`\``)
})

test('thinkingGist は先頭1-2文を要点として返す', () => {
  expect(thinkingGist('まず確認する。次に実装する。最後にテスト。')).toBe('🧠 まず確認する。次に実装する。')
})

test('thinkingGist は空入力で空文字を返す', () => {
  expect(thinkingGist('')).toBe('')
})

test('thinkingGist は長文をコードポイント単位で196字に切り詰める', () => {
  expect(thinkingGist('あ'.repeat(300))).toBe('🧠 ' + 'あ'.repeat(196) + '…')
})

test('thinkingGist は絵文字をコードポイント単位で196字に切り詰める', () => {
  expect(thinkingGist('😀'.repeat(300))).toBe('🧠 ' + '😀'.repeat(196) + '…')
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

test('threadName は絵文字をサロゲートペア単位で数えて切り詰める', () => {
  expect(threadName('😀'.repeat(100), new Date(2026, 5, 1, 20, 13))).toBe('[06/01 20:13] ' + '😀'.repeat(79) + '…')
})

test('threadName は本文が空白のみなら progress にする', () => {
  expect(threadName('', new Date(2026, 5, 1, 20, 13))).toBe('[06/01 20:13] progress')
  expect(threadName('   ', new Date(2026, 5, 1, 20, 13))).toBe('[06/01 20:13] progress')
})
