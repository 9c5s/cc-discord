import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  createInitializeRewriter,
  handleClientMessage,
  handleServerMessage,
  type ProxyContext,
} from '../src/proxy'
import { writeHeartbeat, writePointer, type Pointer } from '../src/activation'
import { listTargets, readProgressBody, readTarget } from '../src/progress-target'
import type { ApiResult, DiscordClient } from '../src/discord-api'
import type { Access } from '../src/access'
import type { Json, Writer } from '../src/relay'

const testTmpDir = join(tmpdir(), `discord-proxy-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`)
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
const PID = 4321
const RUN = 'a'.repeat(32)
const ACT = 'b'.repeat(32)
const SESSION = '57db69e6-bf68-407b-8958-680297cb447f'
const CH = '33333333333333333'
const THREAD = '44444444444444444'
const ANCHOR = '88888888888888888'
const DM_CH = '77777777777777777'
const MSG = '99999999999999999'
const USER = '258152380355444736'
const NOW = 1_800_000_000_000

const ACCESS: Access = { allowFrom: [USER], groups: { [CH]: {} } }

function pointer(over: Partial<Pointer> = {}): Pointer {
  return {
    claude_pid: PID,
    run_id: RUN,
    session_id: SESSION,
    activation_id: ACT,
    transcript_path: 'C:\\t.jsonl',
    source: 'startup',
    written_at: NOW,
    ...over,
  }
}

// --- createInitializeRewriter ---

const initializeResult = (id: unknown, instructions: string): Json => ({
  jsonrpc: '2.0',
  id,
  result: { instructions },
})

test('createInitializeRewriter は保留中の initialize の応答で skill 名を書き換える', () => {
  const r = createInitializeRewriter()
  r.noteRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' })
  const out = r.rewrite(initializeResult(1, 'run /discord:access to manage access'))
  expect((out.result as Json).instructions).toBe('run /cc-discord:access to manage access')
})

test('createInitializeRewriter は configure の案内も書き換える', () => {
  const r = createInitializeRewriter()
  r.noteRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' })
  const out = r.rewrite(initializeResult(1, 'see /discord:configure'))
  expect((out.result as Json).instructions).toBe('see /cc-discord:configure')
})

test('createInitializeRewriter は応答の後で同じ id が再利用されても書き換えない', () => {
  const r = createInitializeRewriter()
  r.noteRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' })
  r.rewrite(initializeResult(1, 'run /discord:access'))
  const out = r.rewrite(initializeResult(1, 'run /discord:access'))
  expect((out.result as Json).instructions).toBe('run /discord:access')
})

test('createInitializeRewriter は initialize 以外の要求の id を記録しない', () => {
  const r = createInitializeRewriter()
  r.noteRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call' })
  const out = r.rewrite(initializeResult(1, 'run /discord:access'))
  expect((out.result as Json).instructions).toBe('run /discord:access')
})

test('createInitializeRewriter は id が 0 や文字列でも対応する', () => {
  for (const id of [0, 'init-1']) {
    const r = createInitializeRewriter()
    r.noteRequest({ jsonrpc: '2.0', id, method: 'initialize' })
    const out = r.rewrite(initializeResult(id, '/discord:access'))
    expect((out.result as Json).instructions).toBe('/cc-discord:access')
  }
})

test('createInitializeRewriter は instructions を持たない応答をそのまま返す', () => {
  const r = createInitializeRewriter()
  r.noteRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' })
  const msg: Json = { jsonrpc: '2.0', id: 1, result: { capabilities: {} } }
  expect(r.rewrite(msg)).toBe(msg)
})

// --- 中継のコンテキスト ---

type Harness = {
  ctx: ProxyContext
  toClient: string[]
  toChild: string[]
  posted: Array<{ channelId: string; payload: Record<string, unknown> }>
  typingStarted: string[]
  typingStopped: string[]
  logs: string[]
}

function writer(sink: string[]): Writer {
  return { write: (line: string) => void sink.push(line), broken: false }
}

function harness(over: Record<string, unknown> = {}): Harness {
  const toClient: string[] = []
  const toChild: string[] = []
  const posted: Array<{ channelId: string; payload: Record<string, unknown> }> = []
  const typingStarted: string[] = []
  const typingStopped: string[] = []
  const logs: string[] = []

  const channels: Record<string, Record<string, unknown>> = {
    [CH]: { id: CH, type: 0 },
    [THREAD]: { id: THREAD, type: 11, parent_id: CH },
    [DM_CH]: { id: DM_CH, type: 1, recipients: [{ id: USER }] },
  }
  const api = {
    getChannel: async (id: string): Promise<ApiResult<Record<string, unknown>>> =>
      channels[id] ? { ok: true, value: channels[id] } : { ok: false, error: 'http 404' },
    createMessage: async (channelId: string, payload: Record<string, unknown>) => {
      posted.push({ channelId, payload })
      return { ok: true as const, value: { id: ANCHOR } }
    },
    startThread: async () => ({ ok: true as const, value: { id: THREAD } }),
    editMessage: async (_c: string, id: string) => ({ ok: true as const, value: { id } }),
    ...((over.api as Record<string, unknown>) ?? {}),
  } as unknown as DiscordClient

  const ctx: ProxyContext = {
    rewriter: createInitializeRewriter(),
    ownerCtx: (over.ownerCtx as ProxyContext['ownerCtx']) ?? { kind: 'named', owner: OWNER, dir: 'C:\\example\\proj' },
    api,
    access: () => (over.access as Access) ?? ACCESS,
    ownerChannelId: () => (over.ownerChannelId as string | null | undefined) === undefined ? CH : (over.ownerChannelId as string | null),
    typing: {
      start: (id: string) => void typingStarted.push(id),
      stop: (id: string) => void typingStopped.push(id),
      stopAll: () => {},
    },
    claudePid: PID,
    runId: (over.runId as string | null | undefined) === undefined ? RUN : (over.runId as string | null),
    toClient: writer(toClient),
    toChild: writer(toChild),
    footer: () => (over.footer as string) ?? '',
    log: (m: string) => void logs.push(m),
    now: () => NOW,
    sleep: async () => {},
  }
  return { ctx, toClient, toChild, posted, typingStarted, typingStopped, logs }
}

const notification = (over: Record<string, unknown> = {}): Json => ({
  jsonrpc: '2.0',
  method: 'notifications/claude/channel',
  params: {
    content: 'ping',
    meta: { chat_id: CH, message_id: MSG, user: '9c5s', user_id: USER, ts: '2026-08-23T11:00:00Z', ...over },
  },
})

const raw = (msg: Json): string => JSON.stringify(msg)

// --- inbound の判定 ---

test('handleServerMessage は担当チャンネルの通知を転送しロックと typing と宛先を作る', async () => {
  writePointer(pointer())
  const h = harness()
  const msg = notification()
  await handleServerMessage(msg, raw(msg), h.ctx)

  expect(h.toClient).toEqual([raw(msg)])
  expect(h.typingStarted).toEqual([CH])
  expect(readProgressBody(OWNER)).toBe(THREAD)
  expect(readTarget(OWNER, ACT)?.id).toBe(THREAD)
  expect(readTarget(OWNER, ACT)?.parent).toBe(CH)
  expect(readTarget(OWNER, ACT)?.message_id).toBe(MSG)
})

test('handleServerMessage は担当外のチャンネルの通知を破棄する', async () => {
  const h = harness({ ownerChannelId: '66666666666666666' })
  const msg = notification()
  await handleServerMessage(msg, raw(msg), h.ctx)
  expect(h.toClient).toEqual([])
  expect(h.typingStarted).toEqual([])
})

test('handleServerMessage は担当なしのセッションでは通知を素通しする', async () => {
  const h = harness({ ownerCtx: { kind: 'none' } })
  const msg = notification()
  await handleServerMessage(msg, raw(msg), h.ctx)
  expect(h.toClient).toEqual([raw(msg)])
  expect(h.typingStarted).toEqual([])
})

test('handleServerMessage は担当名が壊れていれば通知を破棄する', async () => {
  const h = harness({ ownerCtx: { kind: 'broken', dir: 'C:\\example\\---' } })
  const msg = notification()
  await handleServerMessage(msg, raw(msg), h.ctx)
  expect(h.toClient).toEqual([])
})

test('handleServerMessage は識別子の形式が不正な通知を破棄する', async () => {
  const h = harness()
  const msg = notification({ chat_id: '../evil' })
  await handleServerMessage(msg, raw(msg), h.ctx)
  expect(h.toClient).toEqual([])
})

test('handleServerMessage はチャンネル取得に失敗した通知を破棄する', async () => {
  const h = harness({ api: { getChannel: async () => ({ ok: false, error: 'http 403' }) } })
  const msg = notification()
  await handleServerMessage(msg, raw(msg), h.ctx)
  expect(h.toClient).toEqual([])
})

test('handleServerMessage は同じ message_id を二重に処理しない', async () => {
  writePointer(pointer())
  const h = harness()
  const msg = notification()
  await handleServerMessage(msg, raw(msg), h.ctx)
  await handleServerMessage(msg, raw(msg), h.ctx)
  expect(h.toClient).toHaveLength(1)
})

test('handleServerMessage は best effort の失敗でも通知を転送する', async () => {
  writePointer(pointer())
  const h = harness({ api: { createMessage: async () => ({ ok: false, error: 'http 403' }) } })
  const msg = notification()
  await handleServerMessage(msg, raw(msg), h.ctx)
  expect(h.toClient).toEqual([raw(msg)])
  // アンカーを作れないときは親チャンネルへ退避する
  expect(readTarget(OWNER, ACT)?.id).toBe(CH)
})

test('handleServerMessage は現行 activation が無ければ宛先を書かずに転送する', async () => {
  const h = harness()
  const msg = notification()
  await handleServerMessage(msg, raw(msg), h.ctx)
  expect(h.toClient).toEqual([raw(msg)])
  expect(listTargets(OWNER)).toEqual([])
  expect(readProgressBody(OWNER)).toBe(THREAD)
})

test('handleServerMessage は run_id を持たないセッションで宛先を書かない', async () => {
  writePointer(pointer())
  const h = harness({ runId: null })
  const msg = notification()
  await handleServerMessage(msg, raw(msg), h.ctx)
  expect(h.toClient).toEqual([raw(msg)])
  expect(listTargets(OWNER)).toEqual([])
})

test('handleServerMessage は通知以外のメッセージを素通しする', async () => {
  const h = harness()
  const msg: Json = { jsonrpc: '2.0', id: 7, result: { tools: [] } }
  await handleServerMessage(msg, raw(msg), h.ctx)
  expect(h.toClient).toEqual([raw(msg)])
})

// --- client -> server ---

test('handleClientMessage は take over 以外を子へ転送する', () => {
  const h = harness()
  const msg: Json = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'react', arguments: {} } }
  handleClientMessage(msg, raw(msg), h.ctx)
  expect(h.toChild).toEqual([raw(msg)])
})

test('handleClientMessage は reply を子へ転送せず自分で応答する', async () => {
  const h = harness()
  const msg: Json = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'reply', arguments: { chat_id: CH, text: 'hi' } } }
  await handleClientMessage(msg, raw(msg), h.ctx)
  expect(h.toChild).toEqual([])
  expect(h.toClient).toHaveLength(1)
  const res = JSON.parse(h.toClient[0]) as Json
  expect(res.id).toBe(1)
  expect((res.result as Json).content).toEqual([{ type: 'text', text: `sent (id: ${ANCHOR})` }])
})

test('handleClientMessage は reply の id の型を保つ', async () => {
  for (const id of [0, 'call-1']) {
    const h = harness()
    const msg: Json = { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'reply', arguments: { chat_id: CH, text: 'hi' } } }
    await handleClientMessage(msg, raw(msg), h.ctx)
    expect((JSON.parse(h.toClient[0]) as Json).id).toBe(id)
  }
})

test('handleClientMessage は reply に二重応答しない', async () => {
  const h = harness()
  const msg: Json = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'reply', arguments: { chat_id: CH, text: 'hi' } } }
  await handleClientMessage(msg, raw(msg), h.ctx)
  expect(h.toClient).toHaveLength(1)
})

test('handleClientMessage は edit_message も take over する', async () => {
  const h = harness()
  const msg: Json = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'edit_message', arguments: { chat_id: CH, message_id: MSG, text: 'new' } },
  }
  await handleClientMessage(msg, raw(msg), h.ctx)
  expect(h.toChild).toEqual([])
  const res = JSON.parse(h.toClient[0]) as Json
  expect((res.result as Json).content).toEqual([{ type: 'text', text: `edited (id: ${MSG})` }])
})

test('handleClientMessage は reply の take over で footer を付ける', async () => {
  const h = harness({ footer: '```\nstatus\n```' })
  const msg: Json = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'reply', arguments: { chat_id: CH, text: 'hi' } } }
  await handleClientMessage(msg, raw(msg), h.ctx)
  expect(h.posted[0].payload.content).toBe('hi\n```\nstatus\n```')
})

test('handleClientMessage は id を持たない tools/call に応答しない', async () => {
  const h = harness()
  const msg: Json = { jsonrpc: '2.0', method: 'tools/call', params: { name: 'reply', arguments: { chat_id: CH, text: 'hi' } } }
  await handleClientMessage(msg, raw(msg), h.ctx)
  expect(h.toClient).toEqual([])
  expect(h.toChild).toEqual([])
})

test('handleClientMessage は initialize を記録して子へ転送する', () => {
  const h = harness()
  const msg: Json = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }
  handleClientMessage(msg, raw(msg), h.ctx)
  expect(h.toChild).toEqual([raw(msg)])
})
