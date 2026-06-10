import { test, expect } from 'bun:test'
import { extractMessages, packMessages, splitLines } from '../src/watch'

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
  expect(extractMessages(line)).toEqual(['```\n⚙️[Bash]\nls\n```'])
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

// タスクF: 1800 コードポイント超の text が切り詰められ ... が付くテスト
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

// タスクG: splitLines のテスト
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
