import { test, expect, afterEach } from 'bun:test'
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createTailReader, extractMessages, packMessages, splitLines } from '../src/watch'

const testTmpDir = join(tmpdir(), `discord-watch-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`)

afterEach(() => {
  rmSync(testTmpDir, { recursive: true, force: true })
})

function transcriptPath(): string {
  mkdirSync(testTmpDir, { recursive: true })
  return join(testTmpDir, 'transcript.jsonl')
}

test('thinking ブロックから要点を抽出する', () => {
  const line = '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"まず確認する。次に実装する。"}]}}'
  expect(extractMessages(line)).toEqual(['🧠 まず確認する。次に実装する。'])
})

test('text ブロックから本文を抽出する', () => {
  const line = '{"type":"assistant","message":{"content":[{"type":"text","text":"実装が完了しました。"}]}}'
  expect(extractMessages(line)).toEqual(['💬 実装が完了しました。'])
})

test('tool_use ブロックを toolSummary で文字列化する', () => {
  const line = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"x","name":"Bash","input":{"command":"ls"}}]}}'
  expect(extractMessages(line)).toEqual(['`⚙️[Bash]`\n```bash\nls\n```'])
})

test('file_path 引数を持つ tool_use はファイル名のみ示す', () => {
  const line = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"x","name":"Edit","input":{"file_path":"D:\\\\proj\\\\foo.ts"}}]}}'
  expect(extractMessages(line)).toEqual(['`⚙️[Edit] foo.ts`'])
})

test('引数の無い tool_use はツール名のみ', () => {
  const line = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"x","name":"TaskList","input":{}}]}}'
  expect(extractMessages(line)).toEqual(['`⚙️[TaskList]`'])
})

test('text と tool_use が混在する場合は出現順で抽出する', () => {
  const line = '{"type":"assistant","message":{"content":[{"type":"text","text":"了解。"},{"type":"tool_use","id":"x","name":"TaskList","input":{}}]}}'
  expect(extractMessages(line)).toEqual(['💬 了解。', '`⚙️[TaskList]`'])
})

test('非 assistant 行はスキップする', () => {
  const line = '{"type":"user","message":{"content":[]}}'
  expect(extractMessages(line)).toEqual([])
})

test('空の thinking は除外する', () => {
  const line = '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":""}]}}'
  expect(extractMessages(line)).toEqual([])
})

test('不正な JSON 行はスキップする', () => {
  expect(extractMessages('not json')).toEqual([])
})

test('複数ブロックを順に抽出する', () => {
  const line = '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"まず確認する。次に実装する。"},{"type":"text","text":"実装が完了しました。"}]}}'
  expect(extractMessages(line)).toEqual(['🧠 まず確認する。次に実装する。', '💬 実装が完了しました。'])
})

test('空行はスキップする', () => {
  expect(extractMessages('')).toEqual([])
})

test('"No response requested." はスキップする', () => {
  const line = '{"type":"assistant","message":{"content":[{"type":"text","text":"No response requested."}]}}'
  expect(extractMessages(line)).toEqual([])
})

test('前後空白付きの "No response requested." もスキップする', () => {
  const line = '{"type":"assistant","message":{"content":[{"type":"text","text":"  No response requested.\\n"}]}}'
  expect(extractMessages(line)).toEqual([])
})

test('packMessages は合計が上限以下なら1チャンクにまとめる', () => {
  expect(packMessages(['a', 'b'], 10)).toEqual(['a\nb'])
})

test('packMessages は上限を超えるときメッセージ境界で分割する', () => {
  expect(packMessages(['aaaa', 'bbbb', 'cc'], 9)).toEqual(['aaaa\nbbbb', 'cc'])
})

test('packMessages は単一の巨大メッセージをそのまま1チャンクにする', () => {
  expect(packMessages(['x'.repeat(30)], 10)).toEqual(['x'.repeat(30)])
})

test('packMessages は空配列で空配列を返す', () => {
  expect(packMessages([], 10)).toEqual([])
})

// 1800 コードポイント超の text が切り詰められ ... が付くテスト
test('1800 コードポイント超の text は切り詰めて ... を付ける', () => {
  const longText = 'あ'.repeat(1801)
  const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: longText }] } })
  expect(extractMessages(line)).toEqual(['💬 ' + 'あ'.repeat(1800) + '…'])
})

test('1800 コードポイント以下の text はそのまま通す', () => {
  const text = 'あ'.repeat(1800)
  const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: text }] } })
  expect(extractMessages(line)).toEqual(['💬 ' + 'あ'.repeat(1800)])
})

// splitLines のテスト
test('splitLines: 未完行は carry に持ち越す', () => {
  expect(splitLines('', 'abc\ndef')).toEqual({ lines: ['abc'], carry: 'def' })
})

test('splitLines: 複数行を正しく分割する', () => {
  expect(splitLines('', 'line1\nline2\nline3')).toEqual({ lines: ['line1', 'line2'], carry: 'line3' })
})

test('splitLines: 改行で終わるチャンクは carry が空文字になる', () => {
  expect(splitLines('', 'line1\nline2\n')).toEqual({ lines: ['line1', 'line2'], carry: '' })
})

test('splitLines: 空チャンクは carry をそのまま返す', () => {
  expect(splitLines('prev', '')).toEqual({ lines: [], carry: 'prev' })
})

test('splitLines: carry と chunk を結合して分割する', () => {
  expect(splitLines('hel', 'lo\nworld')).toEqual({ lines: ['hello'], carry: 'world' })
})

// --- createTailReader ---

test('createTailReader は作成時点の末尾から読む', () => {
  const p = transcriptPath()
  writeFileSync(p, 'old1\nold2\n')
  const reader = createTailReader(p)
  expect(reader.readNewLines()).toEqual([])
  appendFileSync(p, 'new1\nnew2\n')
  expect(reader.readNewLines()).toEqual(['new1', 'new2'])
  expect(reader.readNewLines()).toEqual([])
})

test('createTailReader はファイルが無ければ作られた後に先頭から読む', () => {
  const p = transcriptPath()
  const reader = createTailReader(p)
  expect(reader.readNewLines()).toEqual([])
  writeFileSync(p, 'first\nsecond\n')
  expect(reader.readNewLines()).toEqual(['first', 'second'])
})

test('createTailReader はファイルが縮んだら先頭から読み直す', () => {
  const p = transcriptPath()
  writeFileSync(p, 'a-long-line\nanother-long-line\n')
  const reader = createTailReader(p)
  writeFileSync(p, 'short\n')
  expect(reader.readNewLines()).toEqual(['short'])
})

test('createTailReader は縮んだときに持ち越していた行の断片を捨てる', () => {
  const p = transcriptPath()
  writeFileSync(p, 'a-long-line\n')
  const reader = createTailReader(p)
  appendFileSync(p, 'partial')
  expect(reader.readNewLines()).toEqual([])
  writeFileSync(p, 'x\n')
  expect(reader.readNewLines()).toEqual(['x'])
})

test('createTailReader は行の途中で切れた分を次回へ持ち越す', () => {
  const p = transcriptPath()
  writeFileSync(p, '')
  const reader = createTailReader(p)
  appendFileSync(p, '{"type":')
  expect(reader.readNewLines()).toEqual([])
  appendFileSync(p, '"assistant"}\nnext')
  expect(reader.readNewLines()).toEqual(['{"type":"assistant"}'])
  appendFileSync(p, '\n')
  expect(reader.readNewLines()).toEqual(['next'])
})

test('createTailReader は途中で切れたマルチバイト文字を次回の読み取りでつなぐ', () => {
  const p = transcriptPath()
  writeFileSync(p, '')
  const reader = createTailReader(p)
  const bytes = Buffer.from('あ\n', 'utf8')
  appendFileSync(p, bytes.subarray(0, 2))
  expect(reader.readNewLines()).toEqual([])
  appendFileSync(p, bytes.subarray(2))
  expect(reader.readNewLines()).toEqual(['あ'])
})
