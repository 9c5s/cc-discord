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

test('tool_use ブロックはスキップする', () => {
  const line = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"x","name":"Bash","input":{}}]}}'
  expect(extractMessages(line)).toEqual([])
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
