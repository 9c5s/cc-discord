import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  TARGET_TTL_MS,
  deleteTarget,
  isActiveFor,
  listTargets,
  progressDir,
  readProgressBody,
  readTarget,
  writeProgressBody,
  writeTarget,
  type ProgressTarget,
} from '../src/progress-target'

const testTmpDir = join(tmpdir(), `discord-target-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`)
let savedStateDir: string | undefined

beforeEach(() => {
  savedStateDir = process.env.DISCORD_STATE_DIR
  process.env.DISCORD_STATE_DIR = join(testTmpDir, 'state')
  mkdirSync(process.env.DISCORD_STATE_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(testTmpDir, { recursive: true, force: true })
  if (savedStateDir === undefined) delete process.env.DISCORD_STATE_DIR
  else process.env.DISCORD_STATE_DIR = savedStateDir
})

const OWNER = 'proj'
const RUN = 'a'.repeat(32)
const ACT = 'b'.repeat(32)
const OTHER_ACT = 'c'.repeat(32)
const SESSION = '57db69e6-bf68-407b-8958-680297cb447f'
const THREAD = '44444444444444444'
const PARENT = '33333333333333333'
const MSG = '99999999999999999'

function target(over: Partial<ProgressTarget> = {}): ProgressTarget {
  return {
    id: THREAD,
    parent: PARENT,
    kind: 'guild',
    session_id: SESSION,
    run_id: RUN,
    activation_id: ACT,
    message_id: MSG,
    written_at: Date.now(),
    ...over,
  }
}

// --- writeTarget / readTarget ---

test('writeTarget は宛先を書き readTarget が同じ内容を返す', () => {
  const t = target()
  expect(writeTarget(OWNER, t)).toBe(true)
  expect(readTarget(OWNER, ACT)).toEqual(t)
})

test('writeTarget は一時ファイルを残さない', () => {
  writeTarget(OWNER, target())
  expect(readdirSync(progressDir())).toEqual([`${OWNER}.${ACT}.meta`])
})

test('readTarget は同じ activation のファイルだけを読む', () => {
  writeTarget(OWNER, target())
  expect(readTarget(OWNER, OTHER_ACT)).toBe(null)
})

test('readTarget はファイル名と内容の activation_id が食い違う宛先を拒否する', () => {
  mkdirSync(progressDir(), { recursive: true })
  writeFileSync(join(progressDir(), `${OWNER}.${ACT}.meta`), JSON.stringify(target({ activation_id: OTHER_ACT })))
  expect(readTarget(OWNER, ACT)).toBe(null)
})

test('readTarget は必須フィールドが欠けた宛先を拒否する', () => {
  mkdirSync(progressDir(), { recursive: true })
  for (const key of ['id', 'parent', 'kind', 'session_id', 'run_id', 'message_id', 'written_at']) {
    const t = target() as Record<string, unknown>
    delete t[key]
    writeFileSync(join(progressDir(), `${OWNER}.${ACT}.meta`), JSON.stringify(t))
    expect(readTarget(OWNER, ACT)).toBe(null)
  }
})

test('readTarget は識別子の形式が不正な宛先を拒否する', () => {
  mkdirSync(progressDir(), { recursive: true })
  for (const bad of [
    { id: 'not-a-snowflake' },
    { parent: '..' },
    { message_id: '' },
    { kind: 'thread' },
    { run_id: 'zz' },
    { session_id: 'nope' },
    { written_at: 'now' },
  ]) {
    writeFileSync(join(progressDir(), `${OWNER}.${ACT}.meta`), JSON.stringify({ ...target(), ...bad }))
    expect(readTarget(OWNER, ACT)).toBe(null)
  }
})

test('readTarget は期限切れの宛先も読む', () => {
  const t = target({ written_at: Date.now() - TARGET_TTL_MS - 1 })
  writeTarget(OWNER, t)
  expect(readTarget(OWNER, ACT)).toEqual(t)
})

test('readTarget はファイルが無ければ null を返す', () => {
  expect(readTarget(OWNER, ACT)).toBe(null)
})

test('readTarget は不正な担当名や activation_id では読まない', () => {
  writeTarget(OWNER, target())
  expect(readTarget('../evil', ACT)).toBe(null)
  expect(readTarget(OWNER, '../evil')).toBe(null)
})

// --- isActiveFor ---

test('isActiveFor は activation が一致し 12 時間以内なら有効とする', () => {
  const now = 100 * TARGET_TTL_MS
  expect(isActiveFor(target({ written_at: now }), ACT, now)).toBe(true)
  expect(isActiveFor(target({ written_at: now - TARGET_TTL_MS }), ACT, now)).toBe(true)
})

test('isActiveFor は activation が違えば無効とする', () => {
  const now = 100 * TARGET_TTL_MS
  expect(isActiveFor(target({ written_at: now }), OTHER_ACT, now)).toBe(false)
})

test('isActiveFor は 12 時間を超えた宛先を無効とする', () => {
  const now = 100 * TARGET_TTL_MS
  expect(isActiveFor(target({ written_at: now - TARGET_TTL_MS - 1 }), ACT, now)).toBe(false)
})

test('isActiveFor は未来の書き込み時刻を無効とする', () => {
  const now = 100 * TARGET_TTL_MS
  expect(isActiveFor(target({ written_at: now + 1 }), ACT, now)).toBe(false)
})

test('TARGET_TTL_MS は 12 時間である', () => {
  expect(TARGET_TTL_MS).toBe(12 * 60 * 60 * 1000)
})

// --- listTargets ---

test('listTargets は同じ担当の宛先を列挙する', () => {
  writeTarget(OWNER, target())
  writeTarget(OWNER, target({ activation_id: OTHER_ACT, id: PARENT, kind: 'dm', parent: PARENT }))
  const list = listTargets(OWNER)
  expect(list.map((e) => e.activationId).sort()).toEqual([ACT, OTHER_ACT].sort())
})

test('listTargets は他の担当の宛先を含めない', () => {
  writeTarget(OWNER, target())
  writeTarget('other', target({ activation_id: OTHER_ACT }))
  expect(listTargets(OWNER).map((e) => e.activationId)).toEqual([ACT])
})

test('listTargets は担当名を区切りまで照合する', () => {
  // 前方一致だけで拾うと proj の掃除が proj-web の宛先を巻き込む
  writeTarget(OWNER, target())
  writeTarget(`${OWNER}-web`, target({ activation_id: OTHER_ACT }))
  expect(listTargets(OWNER).map((e) => e.activationId)).toEqual([ACT])
})

test('listTargets は読めない宛先を除く', () => {
  mkdirSync(progressDir(), { recursive: true })
  writeFileSync(join(progressDir(), `${OWNER}.${ACT}.meta`), 'broken')
  expect(listTargets(OWNER)).toEqual([])
})

test('listTargets はディレクトリが無くても空を返す', () => {
  expect(listTargets(OWNER)).toEqual([])
})

// --- deleteTarget ---

test('deleteTarget は宛先を削除する', () => {
  writeTarget(OWNER, target())
  expect(deleteTarget(OWNER, ACT)).toBe(true)
  expect(readTarget(OWNER, ACT)).toBe(null)
})

test('deleteTarget は宛先が無くても成功として扱う', () => {
  expect(deleteTarget(OWNER, ACT)).toBe(true)
})

// --- 本体 (旧 reader 向け) ---

test('writeProgressBody は素の id を 1 行で書く', () => {
  expect(writeProgressBody(OWNER, THREAD)).toBe(true)
  expect(readFileSync(join(progressDir(), OWNER), 'utf8')).toBe(THREAD)
  expect(readProgressBody(OWNER)).toBe(THREAD)
})

test('readProgressBody はファイルが無ければ null を返す', () => {
  expect(readProgressBody(OWNER)).toBe(null)
})

test('writeProgressBody は本体と宛先を別のファイルに書く', () => {
  writeProgressBody(OWNER, THREAD)
  writeTarget(OWNER, target())
  expect(existsSync(join(progressDir(), OWNER))).toBe(true)
  expect(existsSync(join(progressDir(), `${OWNER}.${ACT}.meta`))).toBe(true)
})
