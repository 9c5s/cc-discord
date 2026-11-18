import { appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { isOwnerName } from './ids'
import { stateDir } from './state-dir'

// 拡張のログを state dir の logs/ へ担当ごとに常時追記する
// 担当名を持たないセッションは cc-discord.log に書く
export function createLogger(owner: string): (msg: string) => void {
  const name = isOwnerName(owner) ? `cc-discord-${owner}.log` : 'cc-discord.log'
  return (msg: string): void => {
    try {
      const dir = join(stateDir(), 'logs')
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      appendFileSync(join(dir, name), `[${new Date().toISOString()}] ${msg}\n`, { mode: 0o600 })
    } catch {
      // ログの失敗は本体を止めない
    }
  }
}
