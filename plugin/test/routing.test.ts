import { test, expect } from 'bun:test'
import {
  INBOUND_MAX_AGE_MS,
  INBOUND_MAX_SKEW_MS,
  classifyInbound,
  decideDelivery,
  decideOutbound,
  inboundFreshness,
  ownerContext,
  resolveOwnerChannel,
  type GuildChannels,
  type OwnerContext,
} from '../src/routing'

// GuildText の候補を組み立てる補助
function guild(guildId: string, channels: Array<{ id: string; name: string; type?: number }>): GuildChannels {
  return { guildId, channels: channels.map((c) => ({ type: 0, ...c })) }
}

// --- resolveOwnerChannel ---

test('resolveOwnerChannel は候補が 1 件なら担当として解決する', () => {
  const guilds = [guild('11111111111111111', [
    { id: '22222222222222222', name: 'proj' },
    { id: '33333333333333333', name: 'general' },
  ])]
  expect(resolveOwnerChannel(guilds, { '22222222222222222': {} }, 'proj')).toEqual({
    kind: 'resolved',
    channelId: '22222222222222222',
    guildId: '11111111111111111',
  })
})

test('resolveOwnerChannel は候補が 0 件なら未解決を返す', () => {
  const guilds = [guild('11111111111111111', [{ id: '33333333333333333', name: 'general' }])]
  expect(resolveOwnerChannel(guilds, { '33333333333333333': {} }, 'proj')).toEqual({ kind: 'unresolved' })
})

test('resolveOwnerChannel は同一 guild 内に同名の候補が 2 件あれば曖昧を返す', () => {
  const guilds = [guild('11111111111111111', [
    { id: '22222222222222222', name: 'proj' },
    { id: '44444444444444444', name: 'Proj' },
  ])]
  expect(resolveOwnerChannel(guilds, { '22222222222222222': {}, '44444444444444444': {} }, 'proj')).toEqual({
    kind: 'ambiguous',
    channelIds: ['22222222222222222', '44444444444444444'],
  })
})

test('resolveOwnerChannel は別の guild に同名の候補があれば曖昧を返す', () => {
  const guilds = [
    guild('11111111111111111', [{ id: '22222222222222222', name: 'proj' }]),
    guild('55555555555555555', [{ id: '66666666666666666', name: 'proj' }]),
  ]
  expect(resolveOwnerChannel(guilds, { '22222222222222222': {}, '66666666666666666': {} }, 'proj')).toEqual({
    kind: 'ambiguous',
    channelIds: ['22222222222222222', '66666666666666666'],
  })
})

test('resolveOwnerChannel は access.groups に無い同名チャンネルを候補にしない', () => {
  const guilds = [guild('11111111111111111', [
    { id: '22222222222222222', name: 'proj' },
    { id: '44444444444444444', name: 'proj' },
  ])]
  expect(resolveOwnerChannel(guilds, { '22222222222222222': {} }, 'proj')).toEqual({
    kind: 'resolved',
    channelId: '22222222222222222',
    guildId: '11111111111111111',
  })
})

test('resolveOwnerChannel は GuildText 以外のチャンネルを候補にしない', () => {
  const guilds: GuildChannels[] = [{
    guildId: '11111111111111111',
    channels: [
      { id: '22222222222222222', name: 'proj', type: 2 },
      { id: '44444444444444444', name: 'proj', type: 11 },
    ],
  }]
  expect(resolveOwnerChannel(guilds, { '22222222222222222': {}, '44444444444444444': {} }, 'proj')).toEqual({ kind: 'unresolved' })
})

test('resolveOwnerChannel はチャンネル名を正規化して担当名と比較する', () => {
  const guilds = [guild('11111111111111111', [{ id: '22222222222222222', name: 'My_Sample Project' }])]
  expect(resolveOwnerChannel(guilds, { '22222222222222222': {} }, 'my-sample-project')).toEqual({
    kind: 'resolved',
    channelId: '22222222222222222',
    guildId: '11111111111111111',
  })
})

test('resolveOwnerChannel は担当名が空なら未解決を返す', () => {
  const guilds = [guild('11111111111111111', [{ id: '22222222222222222', name: '---' }])]
  expect(resolveOwnerChannel(guilds, { '22222222222222222': {} }, '')).toEqual({ kind: 'unresolved' })
})

test('resolveOwnerChannel は id や name が欠けたチャンネルを候補にしない', () => {
  const guilds: GuildChannels[] = [{
    guildId: '11111111111111111',
    channels: [
      { id: '22222222222222222', type: 0 },
      { id: 'not-a-snowflake', name: 'proj', type: 0 },
    ],
  }]
  expect(resolveOwnerChannel(guilds, { '22222222222222222': {}, 'not-a-snowflake': {} }, 'proj')).toEqual({ kind: 'unresolved' })
})

// --- ownerContext ---

test('ownerContext は CC_DISCORD_PROJECT_DIR を CLAUDE_PROJECT_DIR より優先する', () => {
  expect(ownerContext({ CC_DISCORD_PROJECT_DIR: 'C:\\example\\proj', CLAUDE_PROJECT_DIR: 'C:\\example\\tmp\\spike' }))
    .toEqual({ kind: 'named', owner: 'proj', dir: 'C:\\example\\proj' })
})

test('ownerContext は CLAUDE_PROJECT_DIR のベース名を正規化して担当名にする', () => {
  expect(ownerContext({ CLAUDE_PROJECT_DIR: 'C:\\example\\My_Sample Project\\' }))
    .toEqual({ kind: 'named', owner: 'my-sample-project', dir: 'C:\\example\\My_Sample Project\\' })
})

test('ownerContext はどちらも未設定なら担当なしを返す', () => {
  expect(ownerContext({})).toEqual({ kind: 'none' })
  expect(ownerContext({ CLAUDE_PROJECT_DIR: '', CC_DISCORD_PROJECT_DIR: '' })).toEqual({ kind: 'none' })
})

test('ownerContext は正規化名が空になるディレクトリを broken として返す', () => {
  expect(ownerContext({ CLAUDE_PROJECT_DIR: 'C:\\example\\---' })).toEqual({ kind: 'broken', dir: 'C:\\example\\---' })
})

// --- classifyInbound ---

const CHAT = '22222222222222222'
const NOW = 1_800_000_000_000
// 指定時刻に送られたメッセージの snowflake
const snowflakeAt = (at: number): string => String(BigInt(at - 1_420_070_400_000) << 22n)
const MSG = snowflakeAt(NOW)
const named = { kind: 'named', owner: 'proj', dir: 'C:\\example\\proj' } as const

test('classifyInbound は担当なしのとき通知を素通しする', () => {
  expect(classifyInbound({ kind: 'none' }, { chat_id: CHAT, message_id: MSG }, NOW)).toEqual({ action: 'passthrough' })
})

test('classifyInbound は担当名が壊れているとき通知を破棄する', () => {
  const decision = classifyInbound({ kind: 'broken', dir: 'C:\\example\\---' }, { chat_id: CHAT, message_id: MSG })
  expect(decision).toEqual({ action: 'drop', reason: 'ROUTING_BROKEN' })
})

test('classifyInbound は担当名があり識別子が正しければチャンネル実体の確認を求める', () => {
  expect(classifyInbound(named, { chat_id: CHAT, message_id: MSG }, NOW)).toEqual({
    action: 'inspect',
    owner: 'proj',
    chatId: CHAT,
    messageId: MSG,
  })
})

test('classifyInbound は識別子が snowflake でない通知を破棄する', () => {
  expect(classifyInbound(named, { chat_id: '../x', message_id: MSG }, NOW)).toEqual({ action: 'drop', reason: 'INVALID_ID' })
  expect(classifyInbound(named, { chat_id: CHAT, message_id: 'abc' }, NOW)).toEqual({ action: 'drop', reason: 'INVALID_ID' })
  expect(classifyInbound(named, {}, NOW)).toEqual({ action: 'drop', reason: 'INVALID_ID' })
})

test('classifyInbound は古すぎる通知を破棄する', () => {
  const old = snowflakeAt(NOW - 2 * 60 * 60 * 1000)
  expect(classifyInbound(named, { chat_id: CHAT, message_id: old }, NOW)).toEqual({ action: 'drop', reason: 'TOO_OLD' })
})

test('classifyInbound は上限の内側の通知を受け入れる', () => {
  const recent = snowflakeAt(NOW - 30 * 60 * 1000)
  expect(classifyInbound(named, { chat_id: CHAT, message_id: recent }, NOW)).toEqual({
    action: 'inspect',
    owner: 'proj',
    chatId: CHAT,
    messageId: recent,
  })
})

test('classifyInbound は時計のずれで少し未来の通知を受け入れる', () => {
  const future = snowflakeAt(NOW + 60_000)
  expect(classifyInbound(named, { chat_id: CHAT, message_id: future }, NOW).action).toBe('inspect')
})

// --- decideDelivery ---

const OWNER_CH = '33333333333333333'
const THREAD = '44444444444444444'

test('decideDelivery は担当チャンネル自身への通知を配送する', () => {
  const decision = decideDelivery({
    owner: 'proj',
    ownerChannelId: OWNER_CH,
    chatId: OWNER_CH,
    entity: { id: OWNER_CH, type: 0 },
  })
  expect(decision).toEqual({ action: 'handle', kind: 'guild', parentId: OWNER_CH })
})

test('decideDelivery は担当チャンネル配下のスレッドへの通知を配送し親を返す', () => {
  const decision = decideDelivery({
    owner: 'proj',
    ownerChannelId: OWNER_CH,
    chatId: THREAD,
    entity: { id: THREAD, type: 11, parent_id: OWNER_CH },
  })
  expect(decision).toEqual({ action: 'handle', kind: 'guild', parentId: OWNER_CH })
})

test('decideDelivery は担当外のチャンネルへの通知を破棄する', () => {
  const decision = decideDelivery({
    owner: 'proj',
    ownerChannelId: OWNER_CH,
    chatId: '55555555555555555',
    entity: { id: '55555555555555555', type: 0 },
  })
  expect(decision).toEqual({ action: 'drop', reason: 'NOT_OWNED' })
})

test('decideDelivery は担当外チャンネルのスレッドへの通知を破棄する', () => {
  const decision = decideDelivery({
    owner: 'proj',
    ownerChannelId: OWNER_CH,
    chatId: THREAD,
    entity: { id: THREAD, type: 11, parent_id: '55555555555555555' },
  })
  expect(decision).toEqual({ action: 'drop', reason: 'NOT_OWNED' })
})

test('decideDelivery は親を持たないスレッドへの通知を破棄する', () => {
  const decision = decideDelivery({
    owner: 'proj',
    ownerChannelId: OWNER_CH,
    chatId: THREAD,
    entity: { id: THREAD, type: 11 },
  })
  expect(decision).toEqual({ action: 'drop', reason: 'NOT_OWNED' })
})

test('decideDelivery は担当チャンネルが未解決なら guild の通知を破棄する', () => {
  const decision = decideDelivery({
    owner: 'proj',
    ownerChannelId: null,
    chatId: OWNER_CH,
    entity: { id: OWNER_CH, type: 0 },
  })
  expect(decision).toEqual({ action: 'drop', reason: 'NO_OWNER_CHANNEL' })
})

test('decideDelivery は DM 担当のとき DM を配送する', () => {
  const decision = decideDelivery({
    owner: 'cc-discord',
    ownerChannelId: null,
    chatId: CHAT,
    entity: { id: CHAT, type: 1 },
  })
  expect(decision).toEqual({ action: 'handle', kind: 'dm', parentId: CHAT })
})

test('decideDelivery は DM 担当でないセッションの DM を破棄する', () => {
  const decision = decideDelivery({
    owner: 'proj',
    ownerChannelId: OWNER_CH,
    chatId: CHAT,
    entity: { id: CHAT, type: 1 },
  })
  expect(decision).toEqual({ action: 'drop', reason: 'NOT_DM_OWNER' })
})

test('decideDelivery はチャンネル実体を取得できなければ破棄する', () => {
  const decision = decideDelivery({ owner: 'proj', ownerChannelId: OWNER_CH, chatId: OWNER_CH, entity: null })
  expect(decision).toEqual({ action: 'drop', reason: 'CHANNEL_FETCH_FAILED' })
})

test('decideDelivery は取得した実体の id が要求と一致しなければ破棄する', () => {
  const decision = decideDelivery({
    owner: 'proj',
    ownerChannelId: OWNER_CH,
    chatId: OWNER_CH,
    entity: { id: '55555555555555555', type: 0 },
  })
  expect(decision).toEqual({ action: 'drop', reason: 'CHANNEL_ID_MISMATCH' })
})

// --- decideOutbound ---

const OUT_OWNED = '22222222222222222'
const OUT_OTHER = '44444444444444444'
const outNamed: OwnerContext = { kind: 'named', owner: 'proj', dir: '/w/proj' }

test('decideOutbound は担当チャンネルへの送信を許す', () => {
  const entity = { id: OUT_OWNED, type: 0 }
  expect(decideOutbound(outNamed, { ownerChannelId: OUT_OWNED, chatId: OUT_OWNED, entity })).toEqual({ ok: true })
})

test('decideOutbound は担当チャンネル配下のスレッドへの送信を許す', () => {
  const entity = { id: '55555555555555555', type: 11, parent_id: OUT_OWNED }
  expect(decideOutbound(outNamed, { ownerChannelId: OUT_OWNED, chatId: '55555555555555555', entity })).toEqual({ ok: true })
})

test('decideOutbound は担当外のチャンネルへの送信を拒む', () => {
  const entity = { id: OUT_OTHER, type: 0 }
  expect(decideOutbound(outNamed, { ownerChannelId: OUT_OWNED, chatId: OUT_OTHER, entity })).toEqual({
    ok: false,
    reason: 'NOT_OWNED',
  })
})

test('decideOutbound は担当が未解決なら guild への送信を拒む', () => {
  const entity = { id: OUT_OWNED, type: 0 }
  expect(decideOutbound(outNamed, { ownerChannelId: null, chatId: OUT_OWNED, entity })).toEqual({
    ok: false,
    reason: 'NO_OWNER_CHANNEL',
  })
})

test('decideOutbound は実体を取得できなければ拒む', () => {
  expect(decideOutbound(outNamed, { ownerChannelId: OUT_OWNED, chatId: OUT_OWNED, entity: null })).toEqual({
    ok: false,
    reason: 'CHANNEL_FETCH_FAILED',
  })
})

test('decideOutbound は DM を cc-discord 担当のセッションにだけ許す', () => {
  const entity = { id: '66666666666666666', type: 1 }
  const dmOwner: OwnerContext = { kind: 'named', owner: 'cc-discord', dir: '/w/cc-discord' }
  expect(decideOutbound(dmOwner, { ownerChannelId: null, chatId: '66666666666666666', entity })).toEqual({ ok: true })
  expect(decideOutbound(outNamed, { ownerChannelId: OUT_OWNED, chatId: '66666666666666666', entity })).toEqual({
    ok: false,
    reason: 'NOT_DM_OWNER',
  })
})

test('decideOutbound は担当なしのセッションでは判定しない', () => {
  const entity = { id: OUT_OTHER, type: 0 }
  expect(decideOutbound({ kind: 'none' }, { ownerChannelId: null, chatId: OUT_OTHER, entity })).toEqual({ ok: true })
})

test('decideOutbound は担当名が壊れているセッションの送信を拒む', () => {
  const entity = { id: OUT_OTHER, type: 0 }
  expect(decideOutbound({ kind: 'broken', dir: '/w/---' }, { ownerChannelId: null, chatId: OUT_OTHER, entity })).toEqual({
    ok: false,
    reason: 'ROUTING_BROKEN',
  })
})

test('classifyInbound は未来に寄りすぎた通知を破棄する', () => {
  const future = snowflakeAt(NOW + 10 * 60 * 1000)
  expect(classifyInbound(named, { chat_id: CHAT, message_id: future }, NOW)).toEqual({
    action: 'drop',
    reason: 'TOO_NEW',
  })
})

test('inboundFreshness は上限の内と外を区別する', () => {
  expect(inboundFreshness(snowflakeAt(NOW), NOW)).toBe('fresh')
  expect(inboundFreshness(snowflakeAt(NOW - 2 * 60 * 60 * 1000), NOW)).toBe('TOO_OLD')
  expect(inboundFreshness(snowflakeAt(NOW + 10 * 60 * 1000), NOW)).toBe('TOO_NEW')
  expect(inboundFreshness('abc', NOW)).toBe('INVALID_ID')
})

test('inboundFreshness は上限ちょうどを受け入れ 1 ミリ秒の超過を落とす', () => {
  // 固定値で書くと 上限を変えたときにこの境界が検査されなくなる
  expect(inboundFreshness(snowflakeAt(NOW - INBOUND_MAX_AGE_MS), NOW)).toBe('fresh')
  expect(inboundFreshness(snowflakeAt(NOW - INBOUND_MAX_AGE_MS - 1), NOW)).toBe('TOO_OLD')
  expect(inboundFreshness(snowflakeAt(NOW + INBOUND_MAX_SKEW_MS), NOW)).toBe('fresh')
  expect(inboundFreshness(snowflakeAt(NOW + INBOUND_MAX_SKEW_MS + 1), NOW)).toBe('TOO_NEW')
})
