import { test, expect, beforeEach, afterEach } from 'bun:test'
import { join } from 'path'
import { homedir, tmpdir } from 'os'
import { stateDir } from '../src/state-dir'

let savedStateDir: string | undefined

beforeEach(() => {
  savedStateDir = process.env.DISCORD_STATE_DIR
})

afterEach(() => {
  if (savedStateDir === undefined) delete process.env.DISCORD_STATE_DIR
  else process.env.DISCORD_STATE_DIR = savedStateDir
})

test('stateDir は DISCORD_STATE_DIR があればそれを返す', () => {
  const dir = join(tmpdir(), 'discord-state-dir-test')
  process.env.DISCORD_STATE_DIR = dir
  expect(stateDir()).toBe(dir)
})

test('stateDir は DISCORD_STATE_DIR 未設定時に homedir/.claude/channels/discord を返す', () => {
  delete process.env.DISCORD_STATE_DIR
  expect(stateDir()).toBe(join(homedir(), '.claude', 'channels', 'discord'))
})
