import { join } from 'path'
import { readFileSync, existsSync } from 'fs'
import { normalizeName } from './normalize'
import { readRoute, stateDir } from './routes'

const API = 'https://discord.com/api/v10'
// @silent フラグ: Discord の SUPPRESS_NOTIFICATIONS (ビット12)
const SUPPRESS_NOTIFICATIONS = 1 << 12 // 4096

// ボットトークンは環境変数を優先し、なければ .env ファイルから読む
function token(): string | null {
  if (process.env.DISCORD_BOT_TOKEN) return process.env.DISCORD_BOT_TOKEN
  const envf = join(stateDir(), '.env')
  if (!existsSync(envf)) return null
  const m = readFileSync(envf, 'utf8').match(/^DISCORD_BOT_TOKEN=(.*)$/m)
  // 値が引用符で囲まれている場合は除去する
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null
}

// CLAUDE_PROJECT_DIR のベース名を正規化した所有者名を返す
export function ownerName(): string {
  const pd = process.env.CLAUDE_PROJECT_DIR ?? ''
  if (!pd) return ''
  const base = pd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  return normalizeName(base)
}

// 担当チャンネル ID を routes から解決する
export function channelId(): string | null {
  const n = ownerName()
  if (!n) return null
  return readRoute(n)
}

// 進捗用の宛先 ID を progress-thread ファイルから解決する。
// guild text チャンネルでは server.ts が inbound 毎に新規スレッドを作って ID を書き、DM ではチャンネル ID をそのまま書く。
// ファイルが無い、または読めない場合は channelId() にフォールバックする。
export function progressChannelId(): string | null {
  const n = ownerName()
  if (!n) return null
  const f = join(stateDir(), 'progress-thread', n)
  if (!existsSync(f)) return channelId()
  const v = readFileSync(f, 'utf8').trim()
  return v || channelId()
}

// Discord REST API でメッセージを投稿する
async function postMessage(text: string): Promise<void> {
  const t = token()
  const cid = progressChannelId()
  if (!t || !cid || !text.trim()) return
  await fetch(`${API}/channels/${cid}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${t}`, 'Content-Type': 'application/json' },
    // allowed_mentions: 進捗コピーに <@id> や @everyone が含まれても ping が発生しないよう全メンション解決を無効化する
    body: JSON.stringify({ content: text.slice(0, 1900), flags: SUPPRESS_NOTIFICATIONS, allowed_mentions: { parse: [] } }),
  }).catch((e: unknown) => {
    // 本番は無音だが DISCORD_NOTIFY_DEBUG 指定時のみ stderr に出す
    if (process.env.DISCORD_NOTIFY_DEBUG) process.stderr.write(`[notify] fetch failed: ${e}\n`)
  })
}

// 即時送信。watch.ts のポーリングから呼ばれる唯一の送信口。
// 旧設計では PreToolUse hook 経由の tool 通知と watch 経由の text 通知を別経路で送っていたが、
// hook の発火が assistant message の transcript 書き込みより早く Discord 上で順序が逆転していた。
// watch.ts に tool_use 抽出を寄せて単一経路化することで JSONL の content 順を表示順に保つ。
export async function sendNow(line: string): Promise<void> {
  await postMessage(line)
}
