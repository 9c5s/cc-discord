import { join } from 'path'
import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'fs'
import { ownerContext } from './routing'
import { stateDir } from './routes'

// 担当名と認証情報とログの共通ユーティリティ ---
// proxy / hook / watcher が共用する
// 進捗の送信は progress-sender.ts 宛先の管理は progress-target.ts が担う

// デバッグログ基盤
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
export function botToken(): string | null {
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

// 担当ディレクトリのベース名を正規化した所有者名を返す
// 担当ディレクトリの決定 (CC_DISCORD_PROJECT_DIR の優先) は routing.ts に集約する
// 担当なしと broken はどちらも空文字になり 呼び出し側は従来どおり空文字で判定する
export function ownerName(): string {
  const ctx = ownerContext()
  return ctx.kind === 'named' ? ctx.owner : ''
}
