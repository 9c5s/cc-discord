#!/usr/bin/env bun
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'

// 公式 server の起動元解決と対応版判定 ---
// proxy の take over は公式 0.0.4 の reply / edit_message の意味論を移植したものであり
// 上流が変わると tools/list の schema と proxy の処理が食い違う
// これを防ぐため 起動する server.ts の SHA-256 を対応表と照合し 対応外なら子を起動しない

// 版ディレクトリ名 -> 無改変 server.ts の SHA-256
// 上流更新時は 差分 (tools/list の schema / fetchAllowedChannel / assertSendable / chunk /
// 通知 meta / 起動コマンド / skills) を確認してから追加する
export const SUPPORTED_SERVERS: Record<string, string[]> = {
  '0.0.4': ['6edc17d9e9d04930967361ba51c8e03b8f8508647a1dfc11d79ee6a0eb1010b7'],
}

// ファイルの SHA-256 を 16 進小文字で返す
// 読めないファイルは null を返し 呼び出し側で対応外として扱う
export function sha256File(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

// installPath の末尾ディレクトリ名を版として返す
export function versionOf(installPath: string): string {
  return basename(installPath.replace(/[\\/]+$/, ''))
}

// 版と hash が対応表に載っているかを判定する
export function isSupportedServer(
  version: string,
  hash: string | null,
  table: Record<string, string[]> = SUPPORTED_SERVERS,
): boolean {
  if (!hash) return false
  return (table[version] ?? []).includes(hash)
}

// 公式 discord プラグインのインストール先を installed_plugins.json から解決する
// user scope を優先し 無ければ最初のエントリを使う
export function officialPluginDir(configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')): string {
  const reg = JSON.parse(readFileSync(join(configDir, 'plugins', 'installed_plugins.json'), 'utf8')) as Record<string, unknown>
  const plugins = (reg.plugins ?? {}) as Record<string, Array<{ scope?: string; installPath?: string }>>
  const entries = plugins['discord@claude-plugins-official'] ?? []
  const path = entries.find((e) => e.scope === 'user')?.installPath ?? entries[0]?.installPath
  if (!path) throw new Error('discord@claude-plugins-official is not installed')
  return path
}

export type OfficialInspection = {
  installPath: string
  version: string
  execHash: string | null
  pristineHash: string | null
  supported: boolean
  pristineSupported: boolean
}

// 実行ファイル (server.ts) と素のファイル (server.ts.orig) の hash と対応状況を集める
// 起動時判定は実行ファイル 契約テストは素のファイルを見る 2 つの別の検査である
export function inspectOfficial(
  installPath: string,
  table: Record<string, string[]> = SUPPORTED_SERVERS,
): OfficialInspection {
  const version = versionOf(installPath)
  const execHash = sha256File(join(installPath, 'server.ts'))
  const pristineHash = sha256File(join(installPath, 'server.ts.orig'))
  return {
    installPath,
    version,
    execHash,
    pristineHash,
    supported: isSupportedServer(version, execHash, table),
    pristineSupported: isSupportedServer(version, pristineHash, table),
  }
}

// preflight (--check) の出力
// 移行手順とアップデート手順で 起動前に対応状況を確かめるために使う
function printCheck(): void {
  let dir: string
  try {
    dir = officialPluginDir()
  } catch (e) {
    process.stdout.write(`official: ${(e as Error).message}\n`)
    process.exit(1)
  }
  const info = inspectOfficial(dir)
  process.stdout.write(`installPath: ${info.installPath}\n`)
  process.stdout.write(`version:     ${info.version}\n`)
  process.stdout.write(`server.ts:   ${info.execHash ?? '(読めない)'} ${info.supported ? '対応' : '対応外'}\n`)
  process.stdout.write(`server.ts.orig: ${info.pristineHash ?? '(無し)'} ${info.pristineSupported ? '対応' : '対応外'}\n`)
  process.exit(info.supported ? 0 : 1)
}

if (import.meta.main && process.argv.includes('--check')) printCheck()
