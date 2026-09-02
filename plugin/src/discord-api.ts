import { isSnowflake } from './ids'
import { botToken } from './notify'
import type { Channel, ChannelEntity } from './routing'

// Discord REST 呼び出し ---
// 判定ロジックは持たず 呼び出しと形式検証と再送だけを担う
// URL に埋める id は埋める直前に snowflake 形式を検証する
// 全ての呼び出しにタイムアウトを設け 429 は retry_after (上限 5 秒) で 1 回だけ再送する

const API = 'https://discord.com/api/v10'
const TIMEOUT_MS = 15_000
const MAX_RETRY_WAIT_MS = 5_000
// チャンネル実体と guild 情報のキャッシュ
// proxy の担当解決 (60 秒周期) と watcher の gate で同じ鮮度にする
const CACHE_TTL_MS = 60_000

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: string }

export type OutFile = { name: string; data: Uint8Array; type: string }

export type DiscordClient = {
  getChannel(id: string): Promise<ApiResult<ChannelEntity>>
  getGuilds(): Promise<ApiResult<Array<{ id: string }>>>
  getGuildChannels(guildId: string): Promise<ApiResult<Channel[]>>
  getCurrentUser(): Promise<ApiResult<{ id: string }>>
  getActiveThreads(guildId: string): Promise<ApiResult<ChannelEntity[]>>
  sendTyping(channelId: string): Promise<ApiResult<null>>
  createMessage(channelId: string, payload: Record<string, unknown>, files?: OutFile[]): Promise<ApiResult<{ id: string }>>
  editMessage(channelId: string, messageId: string, payload: Record<string, unknown>): Promise<ApiResult<{ id: string }>>
  startThread(channelId: string, messageId: string, payload: Record<string, unknown>): Promise<ApiResult<{ id: string }>>
  archiveThread(threadId: string): Promise<ApiResult<null>>
}

export type ClientOptions = {
  token?: string | null
  fetchFn?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  cacheTtlMs?: number
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function createDiscordClient(opts: ClientOptions = {}): DiscordClient {
  const token = opts.token === undefined ? botToken() : opts.token
  const doFetch = opts.fetchFn ?? fetch
  const sleep = opts.sleep ?? defaultSleep
  const now = opts.now ?? Date.now
  const ttl = opts.cacheTtlMs ?? CACHE_TTL_MS
  const cache = new Map<string, { at: number; value: unknown }>()

  // 429 の待ち時間を応答から決める (本文の retry_after 秒 なければ Retry-After ヘッダ)
  const retryWaitMs = async (res: Response): Promise<number> => {
    let sec = 1
    try {
      const body = (await res.clone().json()) as Record<string, unknown>
      if (typeof body.retry_after === 'number') sec = body.retry_after
    } catch {
      const header = parseFloat(res.headers.get('Retry-After') ?? '1')
      if (!Number.isNaN(header)) sec = header
    }
    return Math.min(sec * 1000, MAX_RETRY_WAIT_MS)
  }

  async function request<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
    if (!token) return { ok: false, error: 'no bot token' }
    const headers: Record<string, string> = { Authorization: `Bot ${token}`, ...(init.headers as Record<string, string>) }
    // multipart では境界を fetch に決めさせるため Content-Type を付けない
    if (typeof init.body === 'string') headers['Content-Type'] = 'application/json'

    const send = async (): Promise<Response | string> => {
      try {
        return await doFetch(`${API}${path}`, { ...init, headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
      } catch (e) {
        return `fetch failed: ${(e as Error).message}`
      }
    }

    let res = await send()
    if (typeof res === 'string') return { ok: false, error: res }
    if (res.status === 429) {
      await sleep(await retryWaitMs(res))
      const retry = await send()
      if (typeof retry === 'string') return { ok: false, error: retry }
      res = retry
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, error: `http ${res.status} ${body.slice(0, 200)}` }
    }
    if (res.status === 204) return { ok: true, value: null as T }
    try {
      return { ok: true, value: (await res.json()) as T }
    } catch (e) {
      return { ok: false, error: `invalid json: ${(e as Error).message}` }
    }
  }

  // 成功した取得だけを TTL 付きでキャッシュする
  async function cached<T>(key: string, fn: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
    const hit = cache.get(key)
    if (hit && now() - hit.at <= ttl) return { ok: true, value: hit.value as T }
    const res = await fn()
    if (res.ok) cache.set(key, { at: now(), value: res.value })
    return res
  }

  const invalidId = (id: string): ApiResult<never> => ({ ok: false, error: `invalid id: ${id}` })

  return {
    getChannel(id) {
      if (!isSnowflake(id)) return Promise.resolve(invalidId(id))
      return cached(`channel:${id}`, () => request<ChannelEntity>(`/channels/${id}`))
    },
    getGuilds() {
      return cached('guilds', () => request<Array<{ id: string }>>('/users/@me/guilds'))
    },
    getGuildChannels(guildId) {
      if (!isSnowflake(guildId)) return Promise.resolve(invalidId(guildId))
      return cached(`guild-channels:${guildId}`, () => request<Channel[]>(`/guilds/${guildId}/channels`))
    },
    getCurrentUser() {
      return cached('me', () => request<{ id: string }>('/users/@me'))
    },
    async getActiveThreads(guildId) {
      if (!isSnowflake(guildId)) return invalidId(guildId)
      const res = await request<{ threads?: ChannelEntity[] }>(`/guilds/${guildId}/threads/active`)
      if (!res.ok) return res
      return { ok: true, value: res.value.threads ?? [] }
    },
    sendTyping(channelId) {
      if (!isSnowflake(channelId)) return Promise.resolve(invalidId(channelId))
      return request<null>(`/channels/${channelId}/typing`, { method: 'POST' })
    },
    createMessage(channelId, payload, files) {
      if (!isSnowflake(channelId)) return Promise.resolve(invalidId(channelId))
      if (!files || files.length === 0) {
        return request<{ id: string }>(`/channels/${channelId}/messages`, { method: 'POST', body: JSON.stringify(payload) })
      }
      const form = new FormData()
      form.append('payload_json', JSON.stringify(payload))
      files.forEach((f, i) => form.append(`files[${i}]`, new File([f.data as BlobPart], f.name, { type: f.type })))
      return request<{ id: string }>(`/channels/${channelId}/messages`, { method: 'POST', body: form })
    },
    editMessage(channelId, messageId, payload) {
      if (!isSnowflake(channelId)) return Promise.resolve(invalidId(channelId))
      if (!isSnowflake(messageId)) return Promise.resolve(invalidId(messageId))
      return request<{ id: string }>(`/channels/${channelId}/messages/${messageId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      })
    },
    startThread(channelId, messageId, payload) {
      if (!isSnowflake(channelId)) return Promise.resolve(invalidId(channelId))
      if (!isSnowflake(messageId)) return Promise.resolve(invalidId(messageId))
      return request<{ id: string }>(`/channels/${channelId}/messages/${messageId}/threads`, {
        method: 'POST',
        body: JSON.stringify(payload),
      })
    },
    archiveThread(threadId) {
      if (!isSnowflake(threadId)) return Promise.resolve(invalidId(threadId))
      return request<null>(`/channels/${threadId}`, { method: 'PATCH', body: JSON.stringify({ archived: true }) })
    },
  }
}
