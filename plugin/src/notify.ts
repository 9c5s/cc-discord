import { join } from 'path'
import { mkdirSync, appendFileSync } from 'fs'
import { ownerContext } from './routing'
import { stateDir } from './state-dir'

// 担当名とログの共通ユーティリティ ---

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

// 担当ディレクトリのベース名を正規化した所有者名を返す
// 担当ディレクトリの決定 (CC_DISCORD_PROJECT_DIR の優先) は routing.ts に集約する
// 担当なしと broken はどちらも空文字になり 呼び出し側は従来どおり空文字で判定する
export function ownerName(): string {
  const ctx = ownerContext()
  return ctx.kind === 'named' ? ctx.owner : ''
}
