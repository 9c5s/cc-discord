import { homedir } from 'os'
import { join } from 'path'

// server.ts と同じ STATE_DIR 規約
// DISCORD_STATE_DIR があればそれを優先
export function stateDir(): string {
  return process.env.DISCORD_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'discord')
}
