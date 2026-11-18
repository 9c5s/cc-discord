import { MessageFlags, RateLimitError, REST, Routes, type Client, type ThreadChannel } from 'discord.js'
import type { DiscordOps } from './extension'
import type { ThreadView } from './stale-threads'

// 拡張が使う discord.js の操作 ---
// どの操作も例外を外へ出さず 失敗は null か false か { ok: false } で返す

// アンカーの本文 (ゼロ幅スペース 1 文字)
const ANCHOR_TEXT = '\u200b'
// 進捗スレッドの自動 archive (分)
const AUTO_ARCHIVE_MINUTES = 60

export type ProgressRest = { post(route: string, options: { body: unknown }): Promise<unknown> }

// 進捗の投稿に使う REST クライアント
// 429 と事前の流量制御では待たずに RateLimitError を投げ タイムアウトと 5xx でも送り直さない
export function createProgressRest(token: string, opts: { api?: string } = {}): ProgressRest {
  return new REST({ rejectOnRateLimit: () => true, retries: 0, ...(opts.api ? { api: opts.api } : {}) }).setToken(token)
}

// 操作の例外を fallback に置き換える
function guard<T>(fallback: T, op: () => T): T {
  try {
    return op()
  } catch {
    return fallback
  }
}

async function guardAsync<T>(fallback: T, op: () => Promise<T>): Promise<T> {
  try {
    return await op()
  } catch {
    return fallback
  }
}

function toThreadView(t: ThreadChannel): ThreadView {
  return {
    id: t.id,
    parentId: t.parentId ?? null,
    ownerId: t.ownerId ?? null,
    name: t.name,
    autoArchiveDuration: t.autoArchiveDuration ?? null,
    lastMessageId: t.lastMessageId ?? null,
    createdTimestamp: t.createdTimestamp ?? null,
  }
}

export function createDiscordOps(client: Client, progressRest: ProgressRest): DiscordOps {
  return {
    // Collection を直接 for-of すると [key, value] になるため values() を使う
    guilds: () =>
      guard([], () =>
        [...client.guilds.cache.values()].map((g) => ({
          guildId: g.id,
          channels: [...g.channels.cache.values()].map((c) => ({ id: c.id, name: c.name, type: c.type })),
        })),
      ),

    botId: () => guard(null, () => client.user?.id ?? null),

    // startThread で作ったスレッドも discord.js がこのキャッシュへ入れる
    channel: (id) => guard(null, () => client.channels.cache.get(id) ?? null),

    sendTyping: (chatId) =>
      guardAsync(undefined, async () => {
        const ch = await client.channels.fetch(chatId)
        if (ch && 'sendTyping' in ch) await ch.sendTyping()
      }),

    postAnchor: (chatId) =>
      guardAsync(null, async () => {
        const ch = await client.channels.fetch(chatId)
        if (!ch || !('send' in ch)) return null
        const sent = await ch.send({
          content: ANCHOR_TEXT,
          flags: MessageFlags.SuppressNotifications,
          allowedMentions: { parse: [] },
        })
        return sent.id
      }),

    startThread: (chatId, anchorId, name) =>
      guardAsync(null, async () => {
        const ch = await client.channels.fetch(chatId)
        if (!ch || !('messages' in ch)) return null
        const anchor = await ch.messages.fetch(anchorId)
        const thread = await anchor.startThread({ name, autoArchiveDuration: AUTO_ARCHIVE_MINUTES })
        return thread.id
      }),

    postProgress: async (targetId, text) => {
      try {
        await progressRest.post(Routes.channelMessages(targetId), {
          body: { content: text, flags: MessageFlags.SuppressNotifications, allowed_mentions: { parse: [] } },
        })
        return { ok: true }
      } catch (e) {
        return e instanceof RateLimitError ? { ok: false, retryAfterMs: e.retryAfter } : { ok: false }
      }
    },

    listActiveThreads: (guildId) =>
      guardAsync([], async () => {
        const guild = client.guilds.cache.get(guildId)
        if (!guild) return []
        const { threads } = await guild.channels.fetchActiveThreads()
        return [...threads.values()].map(toThreadView)
      }),

    archive: (threadId) =>
      guardAsync(false, async () => {
        const ch = await client.channels.fetch(threadId)
        if (!ch?.isThread()) return false
        await ch.setArchived(true)
        return true
      }),
  }
}
