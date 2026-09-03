import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync, symlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { assertSendable, attachFooter, chunk, handleEditMessage, handleReply, resolveChunkLimit } from '../src/reply'
import type { ApiResult, DiscordClient, OutFile } from '../src/discord-api'
import type { Access } from '../src/access'
import type { OwnerContext } from '../src/routing'

const testTmpDir = join(tmpdir(), `discord-reply-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`)
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

// --- chunk ---

test('chunk は上限以下のテキストを分割しない', () => {
  expect(chunk('hello', 10, 'length')).toEqual(['hello'])
})

test('chunk は length モードで上限ごとに切る', () => {
  expect(chunk('abcdefghij', 4, 'length')).toEqual(['abcd', 'efgh', 'ij'])
})

test('chunk は newline モードで段落境界を優先する', () => {
  const text = 'aaaaaaa\n\nbbbbbbbbbb'
  expect(chunk(text, 10, 'newline')).toEqual(['aaaaaaa', 'bbbbbbbbbb'])
})

test('chunk は newline モードで段落が無ければ単一改行で切る', () => {
  const text = 'aaaaaa\nbbbbbbbbbb'
  expect(chunk(text, 10, 'newline')).toEqual(['aaaaaa', 'bbbbbbbbbb'])
})

test('chunk は newline モードで改行が無ければ空白で切る', () => {
  const text = 'aaaaaa bbbb'
  expect(chunk(text, 10, 'newline')).toEqual(['aaaaaa', ' bbbb'])
})

test('chunk は境界が上限の半分以下なら上限で切る', () => {
  const text = 'ab\ncdefghijklmnop'
  expect(chunk(text, 10, 'newline')).toEqual(['ab\ncdefghi', 'jklmnop'])
})

test('chunk は分割後の先頭の改行を落とす', () => {
  expect(chunk('abcd\n\n\nefgh', 4, 'length')).toEqual(['abcd', 'efgh'])
})

// --- resolveChunkLimit ---

test('resolveChunkLimit は既定で 2000 を返す', () => {
  expect(resolveChunkLimit({ allowFrom: [], groups: {} })).toBe(2000)
})

test('resolveChunkLimit は設定値を 1 から 2000 に収める', () => {
  expect(resolveChunkLimit({ allowFrom: [], groups: {}, textChunkLimit: 1800 })).toBe(1800)
  expect(resolveChunkLimit({ allowFrom: [], groups: {}, textChunkLimit: 0 })).toBe(1)
  expect(resolveChunkLimit({ allowFrom: [], groups: {}, textChunkLimit: 9999 })).toBe(2000)
})

// --- attachFooter ---

test('attachFooter は末尾チャンクに収まる footer を結合する', () => {
  expect(attachFooter(['abc'], 'F', 10)).toEqual(['abc\nF'])
})

test('attachFooter は収まらない footer を独立したチャンクにする', () => {
  expect(attachFooter(['abcdefghij'], 'F', 10)).toEqual(['abcdefghij', 'F'])
})

test('attachFooter は footer が無ければ元のチャンクを返す', () => {
  expect(attachFooter(['abc'], '', 10)).toEqual(['abc'])
})

test('attachFooter は末尾チャンクだけに結合する', () => {
  expect(attachFooter(['abcd', 'ef'], 'F', 10)).toEqual(['abcd', 'ef\nF'])
})

// --- assertSendable ---

test('assertSendable は state dir の外のファイルを許す', () => {
  const f = join(testTmpDir, 'outside.txt')
  writeFileSync(f, 'x')
  expect(() => assertSendable(f)).not.toThrow()
})

test('assertSendable は state dir 配下のファイルを拒否する', () => {
  const f = join(process.env.DISCORD_STATE_DIR as string, '.env')
  writeFileSync(f, 'DISCORD_BOT_TOKEN=secret')
  expect(() => assertSendable(f)).toThrow('refusing to send channel state')
})

test('assertSendable は state dir の inbox を許す', () => {
  const inbox = join(process.env.DISCORD_STATE_DIR as string, 'inbox')
  mkdirSync(inbox, { recursive: true })
  const f = join(inbox, 'a.png')
  writeFileSync(f, 'x')
  expect(() => assertSendable(f)).not.toThrow()
})

test('assertSendable は symlink 経由でも state dir 配下を拒否する', () => {
  const f = join(process.env.DISCORD_STATE_DIR as string, 'access.json')
  writeFileSync(f, '{}')
  const link = join(testTmpDir, 'link.json')
  try {
    symlinkSync(f, link)
  } catch {
    return // symlink を作れない環境では確認しない
  }
  expect(() => assertSendable(link)).toThrow('refusing to send channel state')
})

test('assertSendable は state dir と前方一致するだけの別ディレクトリを許す', () => {
  const sibling = `${process.env.DISCORD_STATE_DIR as string}-other`
  mkdirSync(sibling, { recursive: true })
  const f = join(sibling, 'a.txt')
  writeFileSync(f, 'x')
  expect(() => assertSendable(f)).not.toThrow()
})

test('assertSendable は存在しないファイルを素通しする', () => {
  expect(() => assertSendable(join(testTmpDir, 'absent.txt'))).not.toThrow()
})

// --- take over ---

const CH = '33333333333333333'
const MSG = '99999999999999999'
const ACCESS: Access = { allowFrom: [], groups: { [CH]: {} } }
const OWNER_CTX: OwnerContext = { kind: 'named', owner: 'proj', dir: '/w/proj' }

type Sent = { channelId: string; payload: Record<string, unknown>; files?: OutFile[] }

// 送信を記録する REST クライアントの代役
function fakeApi(over: Partial<DiscordClient> = {}) {
  const sent: Sent[] = []
  const edited: Sent[] = []
  let seq = 0
  const api = {
    getChannel: async (id: string): Promise<ApiResult<Record<string, unknown>>> => ({ ok: true, value: { id, type: 0 } }),
    createMessage: async (channelId: string, payload: Record<string, unknown>, files?: OutFile[]) => {
      sent.push({ channelId, payload, files })
      seq++
      return { ok: true as const, value: { id: `1000000000000000${seq}` } }
    },
    editMessage: async (channelId: string, messageId: string, payload: Record<string, unknown>) => {
      edited.push({ channelId, payload })
      return { ok: true as const, value: { id: messageId } }
    },
    ...over,
  } as unknown as DiscordClient
  return { api, sent, edited }
}

function deps(over: Record<string, unknown> = {}) {
  const stopped: string[] = []
  const f = fakeApi((over.api as Partial<DiscordClient>) ?? {})
  return {
    stopped,
    sent: f.sent,
    edited: f.edited,
    deps: {
      api: f.api,
      access: () => (over.access as Access) ?? ACCESS,
      footer: () => (over.footer as string) ?? '',
      stopTyping: (id: string) => void stopped.push(id),
      ownerCtx: (over.ownerCtx as OwnerContext) ?? OWNER_CTX,
      ownerChannelId: () => (over.ownerChannelId === undefined ? CH : (over.ownerChannelId as string | null)),
      ...(over.deps as Record<string, unknown>),
    },
  }
}

test('handleReply は 1 チャンクを送り sent を返す', async () => {
  const d = deps()
  const res = await handleReply({ chat_id: CH, text: 'hello' }, d.deps)
  expect(res.isError).toBeUndefined()
  expect(res.content[0].text).toBe('sent (id: 10000000000000001)')
  expect(d.sent).toHaveLength(1)
  expect(d.sent[0].payload.content).toBe('hello')
})

test('handleReply は allowed_mentions を常に付ける', async () => {
  const d = deps()
  await handleReply({ chat_id: CH, text: 'hi' }, d.deps)
  expect(d.sent[0].payload.allowed_mentions).toEqual({ parse: [] })
})

test('handleReply は複数チャンクの id を並べて返す', async () => {
  const d = deps({ access: { ...ACCESS, textChunkLimit: 3 } })
  const res = await handleReply({ chat_id: CH, text: 'abcdef' }, d.deps)
  expect(d.sent.map((s) => s.payload.content)).toEqual(['abc', 'def'])
  expect(res.content[0].text).toBe('sent 2 parts (ids: 10000000000000001, 10000000000000002)')
})

test('handleReply は reply_to を既定で先頭チャンクにだけ付ける', async () => {
  const d = deps({ access: { ...ACCESS, textChunkLimit: 3 } })
  await handleReply({ chat_id: CH, text: 'abcdef', reply_to: MSG }, d.deps)
  expect(d.sent[0].payload.message_reference).toEqual({ message_id: MSG, fail_if_not_exists: false })
  expect(d.sent[1].payload.message_reference).toBeUndefined()
})

test('handleReply は replyToMode が all なら全チャンクに付ける', async () => {
  const d = deps({ access: { ...ACCESS, textChunkLimit: 3, replyToMode: 'all' } })
  await handleReply({ chat_id: CH, text: 'abcdef', reply_to: MSG }, d.deps)
  expect(d.sent[1].payload.message_reference).toEqual({ message_id: MSG, fail_if_not_exists: false })
})

test('handleReply は replyToMode が off なら付けない', async () => {
  const d = deps({ access: { ...ACCESS, replyToMode: 'off' } })
  await handleReply({ chat_id: CH, text: 'abc', reply_to: MSG }, d.deps)
  expect(d.sent[0].payload.message_reference).toBeUndefined()
})

test('handleReply は footer を末尾チャンクへ結合する', async () => {
  const d = deps({ footer: '```\nstatus\n```' })
  await handleReply({ chat_id: CH, text: 'hi' }, d.deps)
  expect(d.sent[0].payload.content).toBe('hi\n```\nstatus\n```')
})

test('handleReply は typing を停止する', async () => {
  const d = deps()
  await handleReply({ chat_id: CH, text: 'hi' }, d.deps)
  expect(d.stopped).toEqual([CH])
})

test('handleReply は allowlist 外のチャンネルへ送らない', async () => {
  const d = deps({ api: { getChannel: async (id: string) => ({ ok: true, value: { id, type: 0 } }) }, access: { allowFrom: [], groups: {} } })
  const res = await handleReply({ chat_id: CH, text: 'hi' }, d.deps)
  expect(res.isError).toBe(true)
  expect(res.content[0].text).toContain('is not allowlisted — add via /cc-discord:access')
  expect(d.sent).toHaveLength(0)
})

test('handleReply はチャンネル取得に失敗したら送らない', async () => {
  const d = deps({ api: { getChannel: async () => ({ ok: false, error: 'http 403' }) } })
  const res = await handleReply({ chat_id: CH, text: 'hi' }, d.deps)
  expect(res.isError).toBe(true)
  expect(d.sent).toHaveLength(0)
})

test('handleReply は snowflake でない識別子を拒否する', async () => {
  const d = deps()
  expect((await handleReply({ chat_id: '../x', text: 'hi' }, d.deps)).isError).toBe(true)
  expect((await handleReply({ chat_id: CH, text: 'hi', reply_to: 'x' }, d.deps)).isError).toBe(true)
  expect(d.sent).toHaveLength(0)
})

test('handleReply は text が文字列でなければ拒否する', async () => {
  const d = deps()
  const res = await handleReply({ chat_id: CH, text: 42 }, d.deps)
  expect(res.isError).toBe(true)
  expect(d.sent).toHaveLength(0)
})

test('handleReply は送信途中の失敗を件数つきで返す', async () => {
  let calls = 0
  const d = deps({
    access: { ...ACCESS, textChunkLimit: 3 },
    api: {
      createMessage: async () => {
        calls++
        return calls === 1
          ? { ok: true as const, value: { id: '10000000000000001' } }
          : { ok: false as const, error: 'http 500' }
      },
    },
  })
  const res = await handleReply({ chat_id: CH, text: 'abcdef' }, d.deps)
  expect(res.isError).toBe(true)
  expect(res.content[0].text).toContain('reply failed after 1 of 2 chunk(s) sent: http 500')
})

test('handleReply は添付を先頭チャンクにだけ付ける', async () => {
  const file = join(testTmpDir, 'a.txt')
  writeFileSync(file, 'hi')
  const d = deps({ access: { ...ACCESS, textChunkLimit: 3 } })
  await handleReply({ chat_id: CH, text: 'abcdef', files: [file] }, d.deps)
  expect(d.sent[0].files?.[0].name).toBe('a.txt')
  expect(d.sent[1].files).toBeUndefined()
})

test('handleReply は 10 件を超える添付を拒否する', async () => {
  const files: string[] = []
  for (let i = 0; i < 11; i++) {
    const f = join(testTmpDir, `f${i}.txt`)
    writeFileSync(f, 'x')
    files.push(f)
  }
  const d = deps()
  const res = await handleReply({ chat_id: CH, text: 'hi', files }, d.deps)
  expect(res.isError).toBe(true)
  expect(res.content[0].text).toContain('max 10 attachments')
  expect(d.sent).toHaveLength(0)
})

test('handleReply は 10 件を超える添付を読み込む前に拒否する', async () => {
  // 却下するためだけに全部読むと 大きなファイルを並べられただけで proxy のメモリを使う
  // 実在しないパスでも件数の理由で断ることをもって 読み込みに入っていないことを示す
  const files = Array.from({ length: 11 }, (_, i) => join(testTmpDir, `absent-${i}.txt`))
  const d = deps()
  const res = await handleReply({ chat_id: CH, text: 'hi', files }, d.deps)
  expect(res.isError).toBe(true)
  expect(res.content[0].text).toContain('max 10 attachments')
  expect(d.sent).toHaveLength(0)
})

test('handleReply は通常ファイル以外の添付を拒否する', async () => {
  // FIFO やデバイスは size が 0 に見えるためサイズの検査を通り 同期の読み取りで proxy ごと止まりうる
  const dir = join(testTmpDir, 'not-a-file')
  mkdirSync(dir, { recursive: true })
  const d = deps()
  const res = await handleReply({ chat_id: CH, text: 'hi', files: [dir] }, d.deps)
  expect(res.isError).toBe(true)
  expect(res.content[0].text).toContain('not a regular file')
  expect(d.sent).toHaveLength(0)
})

test('handleReply は state dir 配下のファイルを拒否する', async () => {
  const f = join(process.env.DISCORD_STATE_DIR as string, '.env')
  writeFileSync(f, 'secret')
  const d = deps()
  const res = await handleReply({ chat_id: CH, text: 'hi', files: [f] }, d.deps)
  expect(res.isError).toBe(true)
  expect(res.content[0].text).toContain('refusing to send channel state')
  expect(d.sent).toHaveLength(0)
})

test('handleReply は読めないファイルを拒否する', async () => {
  const d = deps()
  const res = await handleReply({ chat_id: CH, text: 'hi', files: [join(testTmpDir, 'absent.txt')] }, d.deps)
  expect(res.isError).toBe(true)
  expect(d.sent).toHaveLength(0)
})

test('handleEditMessage は本文を差し替えて edited を返す', async () => {
  const d = deps()
  const res = await handleEditMessage({ chat_id: CH, message_id: MSG, text: 'new' }, d.deps)
  expect(res.content[0].text).toBe(`edited (id: ${MSG})`)
  expect(d.edited[0].payload).toEqual({ content: 'new', allowed_mentions: { parse: [] } })
})

test('handleEditMessage は allowlist 外を拒否する', async () => {
  const d = deps({ access: { allowFrom: [], groups: {} } })
  const res = await handleEditMessage({ chat_id: CH, message_id: MSG, text: 'new' }, d.deps)
  expect(res.isError).toBe(true)
  expect(d.edited).toHaveLength(0)
})

test('handleEditMessage は snowflake でない識別子を拒否する', async () => {
  const d = deps()
  expect((await handleEditMessage({ chat_id: CH, message_id: 'x', text: 'new' }, d.deps)).isError).toBe(true)
  expect(d.edited).toHaveLength(0)
})

// --- 担当別 outbound gate ---

const FOREIGN = '77777777777777777'

test('handleReply は担当外のチャンネルへは送らない', async () => {
  const d = deps({ access: { allowFrom: [], groups: { [CH]: {}, [FOREIGN]: {} } } })
  const res = await handleReply({ chat_id: FOREIGN, text: 'hi' }, d.deps)
  expect(res.isError).toBe(true)
  expect(res.content[0].text).toContain('not owned by this session')
  expect(d.sent).toHaveLength(0)
})

test('handleReply は担当チャンネル配下のスレッドへは送る', async () => {
  const thread = '88888888888888888'
  const d = deps({
    access: { allowFrom: [], groups: { [CH]: {} } },
    api: {
      getChannel: async (id: string) => ({
        ok: true,
        value: id === thread ? { id, type: 11, parent_id: CH } : { id, type: 0 },
      }),
    },
  })
  const res = await handleReply({ chat_id: thread, text: 'hi' }, d.deps)
  expect(res.isError).toBeUndefined()
  expect(d.sent).toHaveLength(1)
})

test('handleReply は担当が未解決なら送らない', async () => {
  const d = deps({ ownerChannelId: null })
  const res = await handleReply({ chat_id: CH, text: 'hi' }, d.deps)
  expect(res.isError).toBe(true)
  expect(d.sent).toHaveLength(0)
})

test('handleReply は担当なしのセッションでは allowlist だけで判定する', async () => {
  const d = deps({
    ownerCtx: { kind: 'none' },
    ownerChannelId: null,
    access: { allowFrom: [], groups: { [CH]: {}, [FOREIGN]: {} } },
  })
  const res = await handleReply({ chat_id: FOREIGN, text: 'hi' }, d.deps)
  expect(res.isError).toBeUndefined()
  expect(d.sent).toHaveLength(1)
})

test('handleEditMessage は担当外のチャンネルでは編集しない', async () => {
  const d = deps({ access: { allowFrom: [], groups: { [CH]: {}, [FOREIGN]: {} } } })
  const res = await handleEditMessage({ chat_id: FOREIGN, message_id: MSG, text: 'hi' }, d.deps)
  expect(res.isError).toBe(true)
  expect(d.edited).toHaveLength(0)
})

// --- typing の停止 ---

test('handleReply は text が不正でも typing を止める', async () => {
  const d = deps()
  const res = await handleReply({ chat_id: CH, text: 42 }, d.deps)
  expect(res.isError).toBe(true)
  expect(d.stopped).toEqual([CH])
})

test('handleReply は担当外でも typing を止める', async () => {
  const d = deps({ access: { allowFrom: [], groups: { [CH]: {}, [FOREIGN]: {} } } })
  await handleReply({ chat_id: FOREIGN, text: 'hi' }, d.deps)
  expect(d.stopped).toEqual([FOREIGN])
})
