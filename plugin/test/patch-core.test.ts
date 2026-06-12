import { test, expect } from 'bun:test'
import {
  parseVersion, compareVersions, pickLatestVersion, pickPatch, normalizeDiffHeader,
} from '../src/patch-core'

// --- parseVersion ---

test('parseVersion は 0.0.4 を [0,0,4] に解析する', () => {
  expect(parseVersion('0.0.4')).toEqual([0, 0, 4])
})

test('parseVersion は数字とドット以外を含む名前に null を返す', () => {
  expect(parseVersion('v1.2')).toBeNull()
  expect(parseVersion('1.2-rc1')).toBeNull()
  expect(parseVersion('')).toBeNull()
  expect(parseVersion('1..2')).toBeNull()
})

test('parseVersion は要素数の異なるバージョンも解析する', () => {
  expect(parseVersion('10')).toEqual([10])
  expect(parseVersion('1.2.3.4')).toEqual([1, 2, 3, 4])
})

// --- compareVersions ---

test('compareVersions は数値で比較する (0.0.10 > 0.0.4)', () => {
  expect(compareVersions([0, 0, 10], [0, 0, 4])).toBeGreaterThan(0)
})

test('compareVersions は欠けた要素を 0 とみなす (1.0 == 1.0.0)', () => {
  expect(compareVersions([1, 0], [1, 0, 0])).toBe(0)
})

test('compareVersions は前方の要素を優先する (1.0 < 2.0)', () => {
  expect(compareVersions([1, 0], [2, 0])).toBeLessThan(0)
})

// --- pickLatestVersion ---

test('pickLatestVersion は辞書順でなく数値順で最新を選ぶ', () => {
  expect(pickLatestVersion(['0.0.4', '0.0.10', '0.0.2'])).toBe('0.0.10')
})

test('pickLatestVersion は不正な名前を無視する', () => {
  expect(pickLatestVersion(['junk', '0.0.4', 'node_modules'])).toBe('0.0.4')
})

test('pickLatestVersion は有効な名前が無ければ null を返す', () => {
  expect(pickLatestVersion([])).toBeNull()
  expect(pickLatestVersion(['junk'])).toBeNull()
})

// --- pickPatch ---

test('pickPatch は対象バージョンの完全一致を優先する', () => {
  expect(pickPatch(['0.0.3.patch', '0.0.4.patch', '0.0.5.patch'], '0.0.4'))
    .toEqual({ file: '0.0.4.patch', exact: true })
})

test('pickPatch は一致が無ければ最新の .patch にフォールバックする', () => {
  expect(pickPatch(['0.0.3.patch', '0.0.10.patch'], '0.0.12'))
    .toEqual({ file: '0.0.10.patch', exact: false })
})

test('pickPatch は .patch 以外のファイルを無視する', () => {
  expect(pickPatch(['README.md', '0.0.4.patch'], '0.0.4'))
    .toEqual({ file: '0.0.4.patch', exact: true })
})

test('pickPatch は候補が無ければ null を返す', () => {
  expect(pickPatch([], '0.0.4')).toBeNull()
  expect(pickPatch(['README.md'], '0.0.4')).toBeNull()
})

// --- normalizeDiffHeader ---

const RAW_DIFF = [
  'diff --git a/C:/Users/someone/.claude/plugins/marketplaces/x/server.ts b/C:/Users/someone/.claude/plugins/cache/x/0.0.4/server.ts',
  'index 0595fc7..c33df40 100644',
  '--- a/C:/Users/someone/.claude/plugins/marketplaces/x/server.ts',
  '+++ b/C:/Users/someone/.claude/plugins/cache/x/0.0.4/server.ts',
  '@@ -1,3 +1,3 @@',
  ' line1',
  '--- comment line in hunk',
  '+++ added line in hunk',
  ' line3',
  '',
].join('\n')

test('normalizeDiffHeader はヘッダの絶対パスを a/server.ts b/server.ts に置き換える', () => {
  const n = normalizeDiffHeader(RAW_DIFF)
  const lines = n.split('\n')
  expect(lines[0]).toBe('diff --git a/server.ts b/server.ts')
  expect(lines[1]).toBe('index 0595fc7..c33df40 100644')
  expect(lines[2]).toBe('--- a/server.ts')
  expect(lines[3]).toBe('+++ b/server.ts')
})

test('normalizeDiffHeader は hunk 内の --- や +++ で始まる行を変更しない', () => {
  const lines = normalizeDiffHeader(RAW_DIFF).split('\n')
  expect(lines[6]).toBe('--- comment line in hunk')
  expect(lines[7]).toBe('+++ added line in hunk')
})

test('normalizeDiffHeader の結果にローカル絶対パスが残らない', () => {
  expect(normalizeDiffHeader(RAW_DIFF)).not.toContain('C:/Users')
})
