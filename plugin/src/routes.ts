import { homedir } from 'os'
import { join } from 'path'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'

// server.ts と同じ STATE_DIR 規約。DISCORD_STATE_DIR があればそれを優先。
export function stateDir(): string {
  return process.env.DISCORD_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'discord')
}

export function routesDir(): string {
  return join(stateDir(), 'routes')
}

export function writeRoute(normName: string, channelId: string): void {
  // Enforce contract: only accept normalized names matching the normalized pattern.
  // Non-matching names (empty, containing uppercase, special chars, etc) are rejected.
  if (!/^[a-z0-9-]+$/.test(normName)) {
    throw new Error(`Invalid normalized name: ${normName}`)
  }
  const dir = routesDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, normName), channelId, { encoding: 'utf8', mode: 0o600 })
}

export function readRoute(normName: string): string | null {
  // Enforce contract: only accept normalized names matching the normalized pattern.
  // Non-matching names (empty, containing uppercase, special chars, etc) return null.
  if (!/^[a-z0-9-]+$/.test(normName)) {
    return null
  }
  const f = join(routesDir(), normName)
  if (!existsSync(f)) return null
  const v = readFileSync(f, 'utf8').trim()
  return v || null
}
