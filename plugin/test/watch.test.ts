import { test, expect } from 'bun:test'
import { extractMessages, packMessages, extractStatus, withStatus } from '../src/watch'

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

test('extractStatus は assistant 行の model と usage からステータスラインを作る', () => {
  const line = '{"type":"assistant","message":{"model":"claude-fable-5","usage":{"input_tokens":1,"cache_read_input_tokens":88000,"cache_creation_input_tokens":1141,"output_tokens":1931},"content":[]}}'
  expect(extractStatus(line)).toBe('```\nclaude-fable-5 | ctx 89.1k | out 1.9k\n```')
})

test('extractStatus は非 assistant 行で null を返す', () => {
  expect(extractStatus('{"type":"user","message":{"content":[]}}')).toBeNull()
})

test('extractStatus は usage の無い assistant 行で null を返す', () => {
  expect(extractStatus('{"type":"assistant","message":{"model":"claude-fable-5","content":[]}}')).toBeNull()
})

test('extractStatus は不正な JSON 行で null を返す', () => {
  expect(extractStatus('not json')).toBeNull()
})

test('withStatus は 💬 を含むバッチの末尾にステータスを足す', () => {
  expect(withStatus(['💬 完了', '`⚙️[Bash]`'], 'S')).toEqual(['💬 完了', '`⚙️[Bash]`', 'S'])
})

test('withStatus は 💬 の無いバッチには足さない', () => {
  expect(withStatus(['`⚙️[Bash]`'], 'S')).toEqual(['`⚙️[Bash]`'])
})

test('withStatus はステータス null なら何もしない', () => {
  expect(withStatus(['💬 完了'], null)).toEqual(['💬 完了'])
})
