import { homedir } from 'os'
import { join } from 'path'
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync } from 'fs'
import { isOwnerName } from './ids'

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
  if (!isOwnerName(normName)) {
    throw new Error(`Invalid normalized name: ${normName}`)
  }
  const dir = routesDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // 一時ファイルへ書いてから rename する (他の state ファイルと同じ契約)
  const path = join(dir, normName)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, channelId, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
}

// 担当チャンネルの route を削除する
// 正規化済みの名前のみ受け付け 不在は削除済みとみなす
export function deleteRoute(normName: string): boolean {
  if (!isOwnerName(normName)) return false
  try {
    rmSync(join(routesDir(), normName), { force: true })
    return true
  } catch {
    return false
  }
}

export function readRoute(normName: string): string | null {
  // 正規化済みの名前のみ受け付ける契約を関数側で強制する
  // 空文字や大文字や記号入りなど不一致の名前は null を返す
  if (!isOwnerName(normName)) {
    return null
  }
  const f = join(routesDir(), normName)
  if (!existsSync(f)) return null
  const v = readFileSync(f, 'utf8').trim()
  return v || null
}
