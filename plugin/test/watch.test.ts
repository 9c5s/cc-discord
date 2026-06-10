import { test, expect } from 'bun:test'
import { extractMessages } from '../src/watch'

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
  expect(extractMessages(line)).toEqual(['```\n⚙️ [Bash]\nls\n```'])
})

test('file_path 引数を持つ tool_use はファイル名のみ示す', () => {
  const line = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"x","name":"Edit","input":{"file_path":"D:\\\\proj\\\\foo.ts"}}]}}'
  expect(extractMessages(line)).toEqual(['`⚙️ [Edit] foo.ts`'])
})

test('引数の無い tool_use はツール名のみ', () => {
  const line = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"x","name":"TaskList","input":{}}]}}'
  expect(extractMessages(line)).toEqual(['`⚙️ [TaskList]`'])
})

test('text と tool_use が混在する場合は出現順で抽出する', () => {
  const line = '{"type":"assistant","message":{"content":[{"type":"text","text":"了解。"},{"type":"tool_use","id":"x","name":"TaskList","input":{}}]}}'
  expect(extractMessages(line)).toEqual(['💬 了解。', '`⚙️ [TaskList]`'])
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
