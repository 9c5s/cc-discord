import { homedir } from 'os'
import { join } from 'path'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'

// server.ts と同じ STATE_DIR 規約
// DISCORD_STATE_DIR があればそれを優先
export function stateDir(): string {
  return process.env.DISCORD_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'discord')
}

export function routesDir(): string {
  return join(stateDir(), 'routes')
}

export function writeRoute(normName: string, channelId: string): void {
  // 正規化済みの名前のみ受け付ける契約を関数側で強制する
  // 空文字や大文字や記号入りなど不一致の名前は throw で拒否する
  if (!/^[a-z0-9-]+$/.test(normName)) {
    throw new Error(`Invalid normalized name: ${normName}`)
  }
  const dir = routesDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, normName), channelId, { encoding: 'utf8', mode: 0o600 })
}

export function readRoute(normName: string): string | null {
  // 正規化済みの名前のみ受け付ける契約を関数側で強制する
  // 空文字や大文字や記号入りなど不一致の名前は null を返す
  if (!/^[a-z0-9-]+$/.test(normName)) {
    return null
  }
  const f = join(routesDir(), normName)
  if (!existsSync(f)) return null
  const v = readFileSync(f, 'utf8').trim()
  return v || null
}
