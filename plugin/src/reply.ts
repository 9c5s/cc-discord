import { readFileSync, realpathSync, statSync } from 'fs'
import { basename, join, sep } from 'path'
import { isAllowedTarget, type Access } from './access'
import type { DiscordClient, OutFile } from './discord-api'
import { isSnowflake } from './ids'
import { stateDir } from './routes'

// reply / edit_message の take over ---
// 公式 0.0.4 の意味論 (引数 chunk outbound gate assertSendable) を移植する
// 転送してテキストを書き換える案は mention の表示が変わり footer の結合もできないため採らない

// Discord の 1 メッセージあたりの上限
const MAX_CHUNK_LIMIT = 2000
// 添付の上限 (公式と同じ)
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
export const MAX_ATTACHMENTS = 10

// 長いテキストを分割する (公式から移植)
// newline モードでは段落 単一改行 空白の順に境界を探し 上限の半分より手前なら諦めて上限で切る
export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

// access.textChunkLimit を 1 から 2000 の範囲に収める (公式と同じ)
export function resolveChunkLimit(access: Access): number {
  return Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
}

// footer を末尾チャンクへ結合する
// 改行 1 つを挟んで収まるなら結合し 収まらなければ独立したチャンクとして足す
export function attachFooter(chunks: string[], footer: string, limit: number): string[] {
  if (!footer) return chunks
  const out = [...chunks]
  const last = out.length > 0 ? out[out.length - 1] : ''
  if (out.length > 0 && last.length + 1 + footer.length <= limit) {
    out[out.length - 1] = `${last}\n${footer}`
    return out
  }
  out.push(footer)
  return out
}

// state dir 配下のファイル送信を拒否する (公式から移植)
// realpath で正規化するため symlink 経由も捕捉する
// inbox は添付のダウンロード先なので例外にする
// 存在しないファイルは素通しし 後続の statSync で正しく失敗させる
export function assertSendable(f: string): void {
  let real: string
  let stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(stateDir())
  } catch {
    return
  }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

// take over の実行 ---

export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

export type ReplyDeps = {
  api: DiscordClient
  access: () => Access
  footer: () => string
  stopTyping: (chatId: string) => void
}

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })
const fail = (tool: string, message: string): ToolResult => ({
  content: [{ type: 'text', text: `${tool} failed: ${message}` }],
  isError: true,
})

// 添付を読み込む (公式と同じ順序で 送信禁止 サイズ 件数 を確認する)
function loadFiles(paths: string[]): OutFile[] {
  const out: OutFile[] = []
  for (const p of paths) {
    assertSendable(p)
    const size = statSync(p).size
    if (size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`file too large: ${p} (${(size / 1024 / 1024).toFixed(1)}MB, max 25MB)`)
    }
    out.push({ name: basename(p), data: readFileSync(p), type: 'application/octet-stream' })
  }
  if (out.length > MAX_ATTACHMENTS) throw new Error('Discord allows max 10 attachments per message')
  return out
}

// 宛先が allowlist の内側かを実体で確かめる (公式 fetchAllowedChannel と同じ判定)
async function assertAllowed(deps: ReplyDeps, chatId: string): Promise<void> {
  const res = await deps.api.getChannel(chatId)
  if (!res.ok) throw new Error(`channel ${chatId} lookup failed: ${res.error}`)
  if (!isAllowedTarget(deps.access(), chatId, res.value)) {
    throw new Error(`channel ${chatId} is not allowlisted — add via /cc-discord:access`)
  }
}

// reply の take over
// 子へは転送せず proxy が REST で送り 同じ id の応答を返す
export async function handleReply(args: Record<string, unknown>, deps: ReplyDeps): Promise<ToolResult> {
  const chatId = args.chat_id
  const text = args.text
  const replyTo = args.reply_to
  const files = args.files

  try {
    if (!isSnowflake(chatId)) throw new Error(`invalid chat_id: ${String(chatId)}`)
    if (typeof text !== 'string') throw new Error('text must be a string')
    if (replyTo !== undefined && !isSnowflake(replyTo)) throw new Error(`invalid reply_to: ${String(replyTo)}`)
    if (files !== undefined && (!Array.isArray(files) || files.some((f) => typeof f !== 'string'))) {
      throw new Error('files must be an array of paths')
    }

    // typing は tools/call を受けた時点で無条件に停止する
    // interrupt で reply されないターンの取りこぼしを避けるための明示的な挙動である
    deps.stopTyping(chatId)

    await assertAllowed(deps, chatId)
    const attachments = files ? loadFiles(files as string[]) : []

    const access = deps.access()
    const limit = resolveChunkLimit(access)
    const chunks = attachFooter(chunk(text, limit, access.chunkMode ?? 'length'), deps.footer(), limit)
    const replyMode = access.replyToMode ?? 'first'

    const sentIds: string[] = []
    for (let i = 0; i < chunks.length; i++) {
      const payload: Record<string, unknown> = { content: chunks[i], allowed_mentions: { parse: [] } }
      if (replyTo !== undefined && replyMode !== 'off' && (replyMode === 'all' || i === 0)) {
        payload.message_reference = { message_id: replyTo, fail_if_not_exists: false }
      }
      const res = await deps.api.createMessage(chatId, payload, i === 0 && attachments.length > 0 ? attachments : undefined)
      if (!res.ok) {
        throw new Error(`reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${res.error}`)
      }
      sentIds.push(res.value.id)
    }

    return ok(sentIds.length === 1 ? `sent (id: ${sentIds[0]})` : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`)
  } catch (e) {
    return fail('reply', e instanceof Error ? e.message : String(e))
  }
}

// edit_message の take over
export async function handleEditMessage(args: Record<string, unknown>, deps: ReplyDeps): Promise<ToolResult> {
  const chatId = args.chat_id
  const messageId = args.message_id
  const text = args.text

  try {
    if (!isSnowflake(chatId)) throw new Error(`invalid chat_id: ${String(chatId)}`)
    if (!isSnowflake(messageId)) throw new Error(`invalid message_id: ${String(messageId)}`)
    if (typeof text !== 'string') throw new Error('text must be a string')

    await assertAllowed(deps, chatId)
    const res = await deps.api.editMessage(chatId, messageId, { content: text, allowed_mentions: { parse: [] } })
    if (!res.ok) throw new Error(res.error)
    return ok(`edited (id: ${res.value.id})`)
  } catch (e) {
    return fail('edit_message', e instanceof Error ? e.message : String(e))
  }
}
