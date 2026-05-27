import { test, expect } from 'bun:test'
import { normalizeName } from './normalize'

test('lowercases', () => {
  expect(normalizeName('Discord')).toBe('discord')
})
test('spaces and underscores become hyphens', () => {
  expect(normalizeName('My Project')).toBe('my-project')
  expect(normalizeName('my_project')).toBe('my-project')
})
test('strips non-alphanumeric except hyphen', () => {
  expect(normalizeName('proj@#a!')).toBe('proja')
  expect(normalizeName('a.b.c')).toBe('abc')
})
test('collapses repeated hyphens and trims', () => {
  expect(normalizeName('  a  b  ')).toBe('a-b')
  expect(normalizeName('a--b')).toBe('a-b')
})
