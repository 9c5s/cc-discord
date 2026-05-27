import { test, expect } from 'bun:test'
import { normalizeName } from '../src/normalize'

test('小文字化する', () => {
  expect(normalizeName('Discord')).toBe('discord')
})
test('空白とアンダースコアをハイフンにする', () => {
  expect(normalizeName('My Project')).toBe('my-project')
  expect(normalizeName('my_project')).toBe('my-project')
})
test('英数とハイフン以外を除去する', () => {
  expect(normalizeName('proj@#a!')).toBe('proja')
  expect(normalizeName('a.b.c')).toBe('abc')
})
test('連続ハイフンを統一し前後を除去する', () => {
  expect(normalizeName('  a  b  ')).toBe('a-b')
  expect(normalizeName('a--b')).toBe('a-b')
})
test('空文字列や記号のみは空文字列を返す', () => {
  expect(normalizeName('')).toBe('')
  expect(normalizeName('!!!')).toBe('')
})
