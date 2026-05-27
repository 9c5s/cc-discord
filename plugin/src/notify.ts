import { homedir } from 'os'
import { join } from 'path'
import { readFileSync, existsSync } from 'fs'
import { normalizeName } from './normalize'
import { readRoute } from './routes'

const API = 'https://discord.com/api/v10'
// @silent フラグ: Discord の SUPPRESS_NOTIFICATIONS (ビット12)
const SUPPRESS_NOTIFICATIONS = 1 << 12 // 4096

// ステートディレクトリは DISCORD_STATE_DIR 環境変数 or デフォルトパス
function stateDir(): string {
  return process.env.DISCORD_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'discord')
}

// ボットトークンは環境変数を優先し、なければ .env ファイルから読む
function token(): string | null {
  if (process.env.DISCORD_BOT_TOKEN) return process.env.DISCORD_BOT_TOKEN
  const envf = join(stateDir(), '.env')
  if (!existsSync(envf)) return null
  const m = readFileSync(envf, 'utf8').match(/^DISCORD_BOT_TOKEN=(.*)$/m)
  return m ? m[1].trim() : null
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

// Discord REST API でメッセージを投稿する
async function postMessage(text: string): Promise<void> {
  const t = token()
  const cid = channelId()
  if (!t || !cid || !text.trim()) return
  await fetch(`${API}/channels/${cid}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: text.slice(0, 1900), flags: SUPPRESS_NOTIFICATIONS }),
  }).catch(() => {})
}

// hook(単発)用 -- 即時送信
export async function sendNow(line: string): Promise<void> {
  await postMessage(line)
}

// 監視(常駐)用 -- バッファ経由で送信
const buffer: string[] = []
let timer: ReturnType<typeof setTimeout> | null = null
const MAX_BUFFER = 20

// バッファに追加し 1.5 秒後にフラッシュを予約する
export function enqueue(line: string): void {
  buffer.push(line)
  // バッファ上限を超えたら古いエントリをドロップする
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER)
  if (!timer) timer = setTimeout(flush, 1500)
}

// バッファを結合して1メッセージとして送信する
async function flush(): Promise<void> {
  timer = null
  if (buffer.length === 0) return
  const chunk = buffer.splice(0, buffer.length).join('\n')
  await postMessage(chunk)
}
