import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// 公式 marketplace のクローンの discord ディレクトリ
// tools/upstream.ts の defaultCloneDir と同じ規則である
export function defaultCloneDir(env: NodeJS.ProcessEnv): string {
  const configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return join(configDir, 'plugins', 'marketplaces', 'claude-plugins-official', 'external_plugins', 'discord')
}

// JSON ファイルのトップレベルの文字列を読む 文字列でなければ null
function readJsonString(path: string, key: string): string | null {
  const value = JSON.parse(readFileSync(path, 'utf8'))?.[key]
  return typeof value === 'string' && value ? value : null
}

// クローンの server.ts が取り込み済みの版と違えば footer に出す印 (upstream <版>) を返す
// CC_DISCORD_UPSTREAM_CHECK が空 読み取りの失敗 hash が同じ のいずれかなら null を返す
export function upstreamNotice(input: { env: NodeJS.ProcessEnv; pluginDir: string; cloneDir: string }): string | null {
  if (!input.env.CC_DISCORD_UPSTREAM_CHECK) return null
  try {
    const imported = readJsonString(join(input.pluginDir, 'upstream.json'), 'server_sha256')
    const version = readJsonString(join(input.cloneDir, '.claude-plugin', 'plugin.json'), 'version')
    if (!imported || !version) return null
    const current = createHash('sha256').update(readFileSync(join(input.cloneDir, 'server.ts'))).digest('hex')
    return current === imported ? null : `upstream ${version}`
  } catch {
    return null
  }
}
