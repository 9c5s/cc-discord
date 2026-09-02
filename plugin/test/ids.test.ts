import { test, expect } from 'bun:test'
import { join } from 'path'
import { isSnowflake, isSessionId, isHex32, isPid, resolveInDir } from '../src/ids'

// --- isSnowflake ---

test('isSnowflake は 17 桁から 20 桁の数字列を受け入れる', () => {
  expect(isSnowflake('12345678901234567')).toBe(true)
  expect(isSnowflake('12345678901234567890')).toBe(true)
})

test('isSnowflake は桁数が範囲外の数字列を拒否する', () => {
  expect(isSnowflake('1234567890123456')).toBe(false)
  expect(isSnowflake('123456789012345678901')).toBe(false)
})

test('isSnowflake は数字以外を含む値と空文字とパス片を拒否する', () => {
  expect(isSnowflake('')).toBe(false)
  expect(isSnowflake('..')).toBe(false)
  expect(isSnowflake('1234567890123456789a')).toBe(false)
  expect(isSnowflake('1234567890123456789/x')).toBe(false)
  expect(isSnowflake(' 12345678901234567 ')).toBe(false)
})

test('isSnowflake は末尾に改行を持つ値を拒否する', () => {
  expect(isSnowflake('12345678901234567\n')).toBe(false)
})

test('isSnowflake は文字列以外を拒否する', () => {
  expect(isSnowflake(12345678901234567)).toBe(false)
  expect(isSnowflake(null)).toBe(false)
  expect(isSnowflake(undefined)).toBe(false)
})

// --- isSessionId ---

test('isSessionId は小文字 16 進の UUID 形式を受け入れる', () => {
  expect(isSessionId('57db69e6-bf68-407b-8958-680297cb447f')).toBe(true)
})

test('isSessionId は大文字と桁数違いと区切り違いを拒否する', () => {
  expect(isSessionId('57DB69E6-BF68-407B-8958-680297CB447F')).toBe(false)
  expect(isSessionId('57db69e6-bf68-407b-8958-680297cb447')).toBe(false)
  expect(isSessionId('57db69e6bf68407b8958680297cb447f')).toBe(false)
  expect(isSessionId('')).toBe(false)
  expect(isSessionId('..')).toBe(false)
})

// --- isHex32 ---

test('isHex32 は小文字 16 進 32 文字を受け入れる', () => {
  expect(isHex32('0123456789abcdef0123456789abcdef')).toBe(true)
})

test('isHex32 は長さ違いと大文字と非 16 進を拒否する', () => {
  expect(isHex32('0123456789abcdef0123456789abcde')).toBe(false)
  expect(isHex32('0123456789abcdef0123456789abcdef0')).toBe(false)
  expect(isHex32('0123456789ABCDEF0123456789ABCDEF')).toBe(false)
  expect(isHex32('0123456789abcdef0123456789abcdeg')).toBe(false)
  expect(isHex32('')).toBe(false)
})

// --- isPid ---

test('isPid は 1 桁から 10 桁の数字列を受け入れる', () => {
  expect(isPid('1')).toBe(true)
  expect(isPid('1234567890')).toBe(true)
})

test('isPid は空文字と 11 桁以上と数字以外を拒否する', () => {
  expect(isPid('')).toBe(false)
  expect(isPid('12345678901')).toBe(false)
  expect(isPid('12a')).toBe(false)
  expect(isPid('-1')).toBe(false)
})

// --- resolveInDir ---

test('resolveInDir は対象ディレクトリ直下の名前を解決する', () => {
  expect(resolveInDir('/base/dir', 'file.meta')).toBe(join('/base/dir', 'file.meta'))
})

test('resolveInDir は親へ抜ける名前を拒否する', () => {
  expect(resolveInDir('/base/dir', '..')).toBe(null)
  expect(resolveInDir('/base/dir', '../file')).toBe(null)
  expect(resolveInDir('/base/dir', 'sub/../../file')).toBe(null)
})

test('resolveInDir は下位ディレクトリを含む名前を拒否する', () => {
  expect(resolveInDir('/base/dir', 'sub/file')).toBe(null)
  expect(resolveInDir('/base/dir', 'sub\\file')).toBe(null)
})

test('resolveInDir は空文字とカレント参照を拒否する', () => {
  expect(resolveInDir('/base/dir', '')).toBe(null)
  expect(resolveInDir('/base/dir', '.')).toBe(null)
})

test('resolveInDir は絶対パスを拒否する', () => {
  expect(resolveInDir('/base/dir', '/etc/passwd')).toBe(null)
  expect(resolveInDir('/base/dir', 'C:\\Windows\\System32')).toBe(null)
})
