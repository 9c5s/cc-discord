import { join } from 'path'
import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'fs'
import { ownerFromDir } from './normalize'
import { readRoute, stateDir } from './routes'

const API = 'https://discord.com/api/v10'
// @silent フラグ: Discord の SUPPRESS_NOTIFICATIONS (ビット12)
const SUPPRESS_NOTIFICATIONS = 1 << 12 // 4096

// デバッグログ基盤 ---
// DISCORD_NOTIFY_DEBUG 設定時のみ stateDir()/logs/watch-<owner>.log へ追記する
// ログ失敗で本体を止めないため全体を try/catch で包む
export function debugLog(msg: string): void {
  if (!process.env.DISCORD_NOTIFY_DEBUG) return
  try {
    const logDir = join(stateDir(), 'logs')
    mkdirSync(logDir, { recursive: true, mode: 0o700 })
    const logFile = join(logDir, `watch-${ownerName() || 'unknown'}.log`)
    appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`, { mode: 0o600 })
  } catch {
    // ログ失敗は無視する
  }
}

// ボットトークンは環境変数を優先し なければ .env ファイルから読む
// readFileSync は TOCTOU で throw しうるため try/catch で包み null フォールバックにする
function token(): string | null {
  if (process.env.DISCORD_BOT_TOKEN) return process.env.DISCORD_BOT_TOKEN
  const envf = join(stateDir(), '.env')
  if (!existsSync(envf)) return null
  try {
    const m = readFileSync(envf, 'utf8').match(/^DISCORD_BOT_TOKEN=(.*)$/m)
    // 値が引用符で囲まれている場合は除去する
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null
  } catch {
    return null
  }
}

// CLAUDE_PROJECT_DIR のベース名を正規化した所有者名を返す
export function ownerName(): string {
  return ownerFromDir(process.env.CLAUDE_PROJECT_DIR ?? '')
}

// 担当チャンネル ID を routes から解決する
// readRoute は内部で readFileSync を呼ぶため try/catch で包み null フォールバックにする
export function channelId(): string | null {
  const n = ownerName()
  if (!n) return null
  try {
    return readRoute(n)
  } catch {
    return null
  }
}

// 進捗用の宛先 ID を progress-thread ファイルから解決する
// guild text チャンネルでは server.ts が inbound 毎に新規スレッドを作って ID を書き DM ではチャンネル ID をそのまま書く
// ファイルが無い または読めない場合は channelId() にフォールバックする
// readFileSync は server.ts が inbound 毎にファイルを書き換えるため TOCTOU で throw しうる
// throw を catch して channelId() にフォールバックする
export function progressChannelId(): string | null {
  const n = ownerName()
  if (!n) return null
  const f = join(stateDir(), 'progress-thread', n)
  if (!existsSync(f)) return channelId()
  try {
    const v = readFileSync(f, 'utf8').trim()
    return v || channelId()
  } catch {
    return channelId()
  }
}

// スキップ理由の変化通知用モジュール変数 ---
// 毎ポーリングのノイズを避けるため 直前のスキップ理由を覚えて変化時のみ出力する
let lastSkipReason = ''

// Discord REST API でメッセージを投稿する
// HTTP エラー検知と 429 再送を実装する
// 無音 return の理由を debugLog に出す
async function postMessage(text: string): Promise<void> {
  const t = token()
  const cid = progressChannelId()

  // スキップ理由の可視化 ---
  if (!t) {
    const reason = 'skip: no token'
    if (lastSkipReason !== reason) { debugLog(reason); lastSkipReason = reason }
    return
  }
  if (!cid) {
    const reason = `skip: no route for ${ownerName()}`
    if (lastSkipReason !== reason) { debugLog(reason); lastSkipReason = reason }
    return
  }
  if (!text.trim()) return

  // スキップなしで送信できる場合はスキップ理由をリセットする
  lastSkipReason = ''

  // 最終安全弁の切り捨て
  // サロゲートペアの途中で切らないよう, 末尾に孤立した
  // 上位サロゲートが残った場合は 1 文字余分に落とす
  let content = text.slice(0, 1900)
  const last = content.charCodeAt(content.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) content = content.slice(0, -1)

  const body = JSON.stringify({
    content,
    flags: SUPPRESS_NOTIFICATIONS,
    // allowed_mentions: 進捗コピーに <@id> や @everyone が含まれても ping が発生しないよう全メンション解決を無効化する
    allowed_mentions: { parse: [] },
  })

  // fetch 実行とエラーハンドリング ---
  // タイムアウトを設けないと 1 回のハングで watch の送信チェーン全体が永久に詰まる
  let res: Response
  try {
    res = await fetch(`${API}/channels/${cid}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${t}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(15_000),
    })
  } catch (e: unknown) {
    // ネットワーク例外とタイムアウトは debugLog に出す
    debugLog(`[notify] fetch failed: ${e}`)
    return
  }

  if (!res.ok) {
    if (res.status === 429) {
      // 429: Discord API レートリミット
      // retry_after (秒) または Retry-After ヘッダで待つ
      // 上限は 5 秒とする
      let waitSec = 1
      try {
        const json = await res.clone().json() as Record<string, unknown>
        if (typeof json.retry_after === 'number') waitSec = json.retry_after
      } catch {
        const headerVal = parseFloat(res.headers.get('Retry-After') ?? '1')
        if (!isNaN(headerVal)) waitSec = headerVal
      }
      waitSec = Math.min(waitSec, 5)
      await new Promise<void>((r) => setTimeout(r, waitSec * 1000))
      // 1回だけ再送する
      let retryRes: Response
      try {
        retryRes = await fetch(`${API}/channels/${cid}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bot ${t}`, 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(15_000),
        })
      } catch (e2: unknown) {
        debugLog(`[notify] retry fetch failed: ${e2}`)
        return
      }
      if (!retryRes.ok) {
        const retryBody = await retryRes.text().catch(() => '')
        debugLog(`[notify] retry failed status=${retryRes.status} body=${retryBody.slice(0, 200)}`)
      }
    } else {
      // 429 以外の HTTP エラーは debugLog に出す
      const errBody = await res.text().catch(() => '')
      debugLog(`[notify] http error status=${res.status} body=${errBody.slice(0, 200)}`)
    }
  }
}

// 即時送信
// watch.ts のポーリングから呼ばれる唯一の送信口
// 旧設計では PreToolUse hook 経由の tool 通知と watch 経由の text 通知を別経路で送っていたが
// hook の発火が assistant message の transcript 書き込みより早く Discord 上で順序が逆転していた
// watch.ts に tool_use 抽出を寄せて単一経路化することで JSONL の content 順を表示順に保つ
export async function sendNow(line: string): Promise<void> {
  await postMessage(line)
}
