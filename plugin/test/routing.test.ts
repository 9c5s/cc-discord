import { test, expect } from 'bun:test'
import { classifyInbound, decideDelivery, ownerContext, resolveOwnerChannel, type GuildChannels } from '../src/routing'

// GuildText の候補を組み立てる補助
function guild(guildId: string, channels: Array<{ id: string; name: string; type?: number }>): GuildChannels {
  return { guildId, channels: channels.map((c) => ({ type: 0, ...c })) }
}

// --- resolveOwnerChannel ---

test('resolveOwnerChannel は候補が 1 件なら担当として解決する', () => {
  const guilds = [guild('11111111111111111', [
    { id: '22222222222222222', name: 'eagle' },
    { id: '33333333333333333', name: 'general' },
  ])]
  expect(resolveOwnerChannel(guilds, { '22222222222222222': {} }, 'eagle')).toEqual({
    kind: 'resolved',
    channelId: '22222222222222222',
    guildId: '11111111111111111',
  })
})

test('resolveOwnerChannel は候補が 0 件なら未解決を返す', () => {
  const guilds = [guild('11111111111111111', [{ id: '33333333333333333', name: 'general' }])]
  expect(resolveOwnerChannel(guilds, { '33333333333333333': {} }, 'eagle')).toEqual({ kind: 'unresolved' })
})

test('resolveOwnerChannel は同一 guild 内に同名の候補が 2 件あれば曖昧を返す', () => {
  const guilds = [guild('11111111111111111', [
    { id: '22222222222222222', name: 'eagle' },
    { id: '44444444444444444', name: 'Eagle' },
  ])]
  expect(resolveOwnerChannel(guilds, { '22222222222222222': {}, '44444444444444444': {} }, 'eagle')).toEqual({
    kind: 'ambiguous',
    channelIds: ['22222222222222222', '44444444444444444'],
  })
})

test('resolveOwnerChannel は別の guild に同名の候補があれば曖昧を返す', () => {
  const guilds = [
    guild('11111111111111111', [{ id: '22222222222222222', name: 'eagle' }]),
    guild('55555555555555555', [{ id: '66666666666666666', name: 'eagle' }]),
  ]
  expect(resolveOwnerChannel(guilds, { '22222222222222222': {}, '66666666666666666': {} }, 'eagle')).toEqual({
    kind: 'ambiguous',
    channelIds: ['22222222222222222', '66666666666666666'],
  })
})

test('resolveOwnerChannel は access.groups に無い同名チャンネルを候補にしない', () => {
  const guilds = [guild('11111111111111111', [
    { id: '22222222222222222', name: 'eagle' },
    { id: '44444444444444444', name: 'eagle' },
  ])]
  expect(resolveOwnerChannel(guilds, { '22222222222222222': {} }, 'eagle')).toEqual({
    kind: 'resolved',
    channelId: '22222222222222222',
    guildId: '11111111111111111',
  })
})

test('resolveOwnerChannel は GuildText 以外のチャンネルを候補にしない', () => {
  const guilds: GuildChannels[] = [{
    guildId: '11111111111111111',
    channels: [
      { id: '22222222222222222', name: 'eagle', type: 2 },
      { id: '44444444444444444', name: 'eagle', type: 11 },
    ],
  }]
  expect(resolveOwnerChannel(guilds, { '22222222222222222': {}, '44444444444444444': {} }, 'eagle')).toEqual({ kind: 'unresolved' })
})

test('resolveOwnerChannel はチャンネル名を正規化して担当名と比較する', () => {
  const guilds = [guild('11111111111111111', [{ id: '22222222222222222', name: 'My_Eagle Project' }])]
  expect(resolveOwnerChannel(guilds, { '22222222222222222': {} }, 'my-eagle-project')).toEqual({
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
      { id: 'not-a-snowflake', name: 'eagle', type: 0 },
    ],
  }]
  expect(resolveOwnerChannel(guilds, { '22222222222222222': {}, 'not-a-snowflake': {} }, 'eagle')).toEqual({ kind: 'unresolved' })
})

// --- ownerContext ---

test('ownerContext は CC_DISCORD_PROJECT_DIR を CLAUDE_PROJECT_DIR より優先する', () => {
  expect(ownerContext({ CC_DISCORD_PROJECT_DIR: 'D:\\projects\\eagle', CLAUDE_PROJECT_DIR: 'D:\\projects\\tmp\\spike' }))
    .toEqual({ kind: 'named', owner: 'eagle', dir: 'D:\\projects\\eagle' })
})

test('ownerContext は CLAUDE_PROJECT_DIR のベース名を正規化して担当名にする', () => {
  expect(ownerContext({ CLAUDE_PROJECT_DIR: 'D:\\projects\\My_Eagle Project\\' }))
    .toEqual({ kind: 'named', owner: 'my-eagle-project', dir: 'D:\\projects\\My_Eagle Project\\' })
})

test('ownerContext はどちらも未設定なら担当なしを返す', () => {
  expect(ownerContext({})).toEqual({ kind: 'none' })
  expect(ownerContext({ CLAUDE_PROJECT_DIR: '', CC_DISCORD_PROJECT_DIR: '' })).toEqual({ kind: 'none' })
})

test('ownerContext は正規化名が空になるディレクトリを broken として返す', () => {
  expect(ownerContext({ CLAUDE_PROJECT_DIR: 'D:\\projects\\---' })).toEqual({ kind: 'broken', dir: 'D:\\projects\\---' })
})

// --- classifyInbound ---

const CHAT = '22222222222222222'
const MSG = '99999999999999999'
const named = { kind: 'named', owner: 'eagle', dir: 'D:\\projects\\eagle' } as const

test('classifyInbound は担当なしのとき通知を素通しする', () => {
  expect(classifyInbound({ kind: 'none' }, { chat_id: CHAT, message_id: MSG })).toEqual({ action: 'passthrough' })
})

test('classifyInbound は担当名が壊れているとき通知を破棄する', () => {
  const decision = classifyInbound({ kind: 'broken', dir: 'D:\\projects\\---' }, { chat_id: CHAT, message_id: MSG })
  expect(decision).toEqual({ action: 'drop', reason: 'ROUTING_BROKEN' })
})

test('classifyInbound は担当名があり識別子が正しければチャンネル実体の確認を求める', () => {
  expect(classifyInbound(named, { chat_id: CHAT, message_id: MSG })).toEqual({
    action: 'inspect',
    owner: 'eagle',
    chatId: CHAT,
    messageId: MSG,
  })
})

test('classifyInbound は識別子が snowflake でない通知を破棄する', () => {
  expect(classifyInbound(named, { chat_id: '../x', message_id: MSG })).toEqual({ action: 'drop', reason: 'INVALID_ID' })
  expect(classifyInbound(named, { chat_id: CHAT, message_id: 'abc' })).toEqual({ action: 'drop', reason: 'INVALID_ID' })
  expect(classifyInbound(named, {})).toEqual({ action: 'drop', reason: 'INVALID_ID' })
})

// --- decideDelivery ---

const OWNER_CH = '33333333333333333'
const THREAD = '44444444444444444'

test('decideDelivery は担当チャンネル自身への通知を配送する', () => {
  const decision = decideDelivery({
    owner: 'eagle',
    ownerChannelId: OWNER_CH,
    chatId: OWNER_CH,
    entity: { id: OWNER_CH, type: 0 },
  })
  expect(decision).toEqual({ action: 'handle', kind: 'guild', parentId: OWNER_CH })
})

test('decideDelivery は担当チャンネル配下のスレッドへの通知を配送し親を返す', () => {
  const decision = decideDelivery({
    owner: 'eagle',
    ownerChannelId: OWNER_CH,
    chatId: THREAD,
    entity: { id: THREAD, type: 11, parent_id: OWNER_CH },
  })
  expect(decision).toEqual({ action: 'handle', kind: 'guild', parentId: OWNER_CH })
})

test('decideDelivery は担当外のチャンネルへの通知を破棄する', () => {
  const decision = decideDelivery({
    owner: 'eagle',
    ownerChannelId: OWNER_CH,
    chatId: '55555555555555555',
    entity: { id: '55555555555555555', type: 0 },
  })
  expect(decision).toEqual({ action: 'drop', reason: 'NOT_OWNED' })
})

test('decideDelivery は担当外チャンネルのスレッドへの通知を破棄する', () => {
  const decision = decideDelivery({
    owner: 'eagle',
    ownerChannelId: OWNER_CH,
    chatId: THREAD,
    entity: { id: THREAD, type: 11, parent_id: '55555555555555555' },
  })
  expect(decision).toEqual({ action: 'drop', reason: 'NOT_OWNED' })
})

test('decideDelivery は親を持たないスレッドへの通知を破棄する', () => {
  const decision = decideDelivery({
    owner: 'eagle',
    ownerChannelId: OWNER_CH,
    chatId: THREAD,
    entity: { id: THREAD, type: 11 },
  })
  expect(decision).toEqual({ action: 'drop', reason: 'NOT_OWNED' })
})

test('decideDelivery は担当チャンネルが未解決なら guild の通知を破棄する', () => {
  const decision = decideDelivery({
    owner: 'eagle',
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
    owner: 'eagle',
    ownerChannelId: OWNER_CH,
    chatId: CHAT,
    entity: { id: CHAT, type: 1 },
  })
  expect(decision).toEqual({ action: 'drop', reason: 'NOT_DM_OWNER' })
})

test('decideDelivery はチャンネル実体を取得できなければ破棄する', () => {
  const decision = decideDelivery({ owner: 'eagle', ownerChannelId: OWNER_CH, chatId: OWNER_CH, entity: null })
  expect(decision).toEqual({ action: 'drop', reason: 'CHANNEL_FETCH_FAILED' })
})

test('decideDelivery は取得した実体の id が要求と一致しなければ破棄する', () => {
  const decision = decideDelivery({
    owner: 'eagle',
    ownerChannelId: OWNER_CH,
    chatId: OWNER_CH,
    entity: { id: '55555555555555555', type: 0 },
  })
  expect(decision).toEqual({ action: 'drop', reason: 'CHANNEL_ID_MISMATCH' })
})
