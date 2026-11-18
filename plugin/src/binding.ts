import { realpathSync } from 'fs'
import { lookupProcess, type ProcessInfo, type ProcessLookup } from './process-tree'

export const MAX_ANCESTORS = 6

export type ChannelDecision = { enabled: boolean; reason: string }

const CHANNEL_FLAGS = new Set(['--channels', '--dangerously-load-development-channels'])

// 実体のパスへ解決し 区切りを / にそろえて末尾の区切りを除く (大文字小文字は win32 だけ同一視する)
function normalizePath(path: string, platform: NodeJS.Platform): string {
  let resolved = path
  try {
    resolved = realpathSync.native(path)
  } catch {
    // 存在しないパスは元の文字列のまま比べる
  }
  const unified = resolved.replace(/\\/g, '/').replace(/\/+$/, '')
  return platform === 'win32' ? unified.toLowerCase() : unified
}

function cwdValue(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cwd') return argv[i + 1]
    if (argv[i].startsWith('--cwd=')) return argv[i].slice('--cwd='.length)
  }
  return undefined
}

// .mcp.json の起動構造 (bun run --cwd <プラグインのディレクトリ> ...) に一致するか
function isRelay(argv: string[] | null, root: string, platform: NodeJS.Platform): boolean {
  if (!argv || !argv.includes('run')) return false
  const cwd = cwdValue(argv)
  return cwd !== undefined && normalizePath(cwd, platform) === root
}

// startPid から親へたどり 起動の中継を飛ばして最初に現れたそれ以外のプロセスを返す
export function findOwnClaude(
  startPid: number,
  pluginRoot: string,
  lookup: (pid: number) => ProcessLookup = lookupProcess,
  maxDepth: number = MAX_ANCESTORS,
  platform: NodeJS.Platform = process.platform,
): ProcessInfo | null {
  const root = normalizePath(pluginRoot, platform)
  let pid = startPid
  for (let depth = 0; depth < maxDepth; depth++) {
    const found = lookup(pid)
    if (found.kind !== 'found') return null
    if (!isRelay(found.info.argv, root, platform)) return found.info
    pid = found.info.ppid
  }
  return null
}

// 自分の Claude Code が書いたポインタだけを返す (PID と作成時刻の両方が一致するもの)
export function selectPointer<P extends { claude_pid: number; claude_started_at?: number }>(
  own: ProcessInfo | null,
  read: (pid: number) => P | null,
): P | null {
  if (!own) return null
  const pointer = read(own.pid)
  return pointer && pointer.claude_pid === own.pid && pointer.claude_started_at === own.startMs ? pointer : null
}

// channel のフラグが次の - で始まるトークンまでと = の右辺に持つ値をカンマで分けて集める
function channelValues(argv: string[]): string[] {
  const values: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const eq = argv[i].indexOf('=')
    if (eq > 0 && CHANNEL_FLAGS.has(argv[i].slice(0, eq))) {
      values.push(...argv[i].slice(eq + 1).split(','))
    } else if (CHANNEL_FLAGS.has(argv[i])) {
      for (let j = i + 1; j < argv.length && !argv[j].startsWith('-'); j++) values.push(...argv[j].split(','))
    }
  }
  return values
}

// 自分の Claude Code の起動引数から channel の有効を判定する (CC_DISCORD_CHANNEL が on か off なら優先する)
export function decideChannel(own: ProcessInfo | null, pluginName: string, env: NodeJS.ProcessEnv): ChannelDecision {
  const override = env.CC_DISCORD_CHANNEL
  if (override === 'on' || override === 'off') {
    return { enabled: override === 'on', reason: `環境変数 CC_DISCORD_CHANNEL=${override} による上書きです` }
  }
  if (!own || !own.argv) {
    return {
      enabled: false,
      reason: '自分の Claude Code の起動引数を取得できないため無効と判定しました。環境変数 CC_DISCORD_CHANNEL=on で有効にできます',
    }
  }
  const prefix = `plugin:${pluginName}@`
  const value = channelValues(own.argv).find((v) => v.startsWith(prefix))
  if (value) {
    return { enabled: true, reason: `Claude Code (PID ${own.pid}) の起動引数に ${value} があるため有効と判定しました` }
  }
  return {
    enabled: false,
    reason: `Claude Code (PID ${own.pid}) の起動引数に ${prefix} で始まる channel の指定が無いため無効と判定しました。環境変数 CC_DISCORD_CHANNEL=on で有効にできます`,
  }
}
