// 公式 discord プラグインの確認と取り込み
//   bun tools/upstream.ts check [dir]   版と変わったファイルを表示する
//   bun tools/upstream.ts merge [dir]   3-way マージで plugin/ へ取り込む
import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

const SOURCE = 'anthropics/claude-plugins-official/external_plugins/discord'

// 配布物に含める公式由来のファイル (3-way マージの対象)
export const TRACKED_FILES: string[] = [
  'server.ts',
  'package.json',
  '.npmrc',
  '.mcp.json',
  'LICENSE',
  'skills/access/SKILL.md',
  'skills/configure/SKILL.md',
]

// マージせず新版を upstream/discord へ写すファイル (bun.lock は plugin へも写す)
const COPIED_FILES = ['bun.lock', '.claude-plugin/plugin.json']

// 上流の新しいファイルとして報告しないファイル
const IGNORED_FILES = ['README.md', 'ACCESS.md']

type Env = Record<string, string | undefined>

export type MergeRunner = (ours: string, base: string, theirs: string) => { code: number | null; stdout: string }

export function defaultCloneDir(env: Env): string {
  const configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return join(configDir, 'plugins', 'marketplaces', 'claude-plugins-official', 'external_plugins', 'discord')
}

export function readVersion(dir: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8'))
    return typeof manifest?.version === 'string' ? manifest.version : null
  } catch {
    return null
  }
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

// dir 配下のファイルを相対パス (区切りは /) で返す (node_modules は除く)
function listFiles(dir: string, prefix = ''): string[] {
  const files: string[] = []
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (!entry.isDirectory()) files.push(rel)
    else if (entry.name !== 'node_modules') files.push(...listFiles(dir, rel))
  }
  return files.sort()
}

// 片方にしか無い場合も差とみなす
function differs(a: string, b: string): boolean {
  const hasA = existsSync(a)
  if (hasA !== existsSync(b)) return true
  return hasA && sha256File(a) !== sha256File(b)
}

// changed は内容が変わった追跡対象 / added は追跡対象でも写すだけでもない新版のファイル
export function compareDirs(baseDir: string, newDir: string): { changed: string[]; added: string[] } {
  const changed = TRACKED_FILES.filter((f) => differs(join(baseDir, f), join(newDir, f)))
  const known = new Set([...TRACKED_FILES, ...COPIED_FILES, ...IGNORED_FILES])
  const added = listFiles(newDir).filter((f) => !known.has(f))
  return { changed, added }
}

// ラベルは衝突マーカーにローカルのパスを出さないために指定する
const defaultRun: MergeRunner = (ours, base, theirs) => {
  const result = spawnSync(
    'git',
    ['merge-file', '-p', '-L', 'plugin', '-L', 'upstream-base', '-L', 'upstream-new', ours, base, theirs],
    { encoding: 'utf8' },
  )
  if (result.error) throw result.error
  return { code: result.status, stdout: result.stdout }
}

// upstream/discord を新版の写しで置き換える
function replaceSnapshot(upstreamDir: string, newDir: string): void {
  rmSync(upstreamDir, { recursive: true, force: true })
  for (const f of [...TRACKED_FILES, ...COPIED_FILES]) {
    const from = join(newDir, f)
    if (!existsSync(from)) continue
    const to = join(upstreamDir, f)
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(from, to)
  }
}

export function mergeUpstream(opts: { repoRoot: string; newDir: string; run?: MergeRunner }): {
  version: string
  conflicts: string[]
  added: string[]
} {
  const { repoRoot, newDir, run = defaultRun } = opts
  const upstreamDir = join(repoRoot, 'upstream', 'discord')
  const pluginDir = join(repoRoot, 'plugin')

  const version = readVersion(newDir)
  if (version === null) throw new Error(`新版の .claude-plugin/plugin.json から版を読み取れません: ${newDir}`)
  const { added } = compareDirs(upstreamDir, newDir)

  // 全結果を集めてから書き込む (1 件でもエラーなら何も書かない)
  const results = new Map<string, string | Buffer>()
  const conflicts: string[] = []
  for (const f of TRACKED_FILES) {
    const theirs = join(newDir, f)
    if (!existsSync(theirs)) throw new Error(`新版に追跡対象 ${f} がありません。`)
    const ours = join(pluginDir, f)
    if (!existsSync(ours)) {
      results.set(f, readFileSync(theirs))
      continue
    }
    const base = join(upstreamDir, f)
    if (!existsSync(base)) throw new Error(`取り込み済みの版に追跡対象 ${f} がありません。`)
    const { code, stdout } = run(ours, base, theirs)
    // 終了コード 0 は衝突なし / 1 から 127 は衝突 / それ以外と null はエラー
    if (code === null || code < 0 || code > 127) {
      throw new Error(`git merge-file がエラーを返しました: ${f} (終了コード ${code})`)
    }
    if (code > 0) conflicts.push(f)
    results.set(f, stdout)
  }
  const lockfile = join(newDir, 'bun.lock')
  if (existsSync(lockfile)) results.set('bun.lock', readFileSync(lockfile))

  for (const [f, content] of results) {
    const path = join(pluginDir, f)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  replaceSnapshot(upstreamDir, newDir)
  const meta = { source: SOURCE, version, server_sha256: sha256File(join(newDir, 'server.ts')) }
  writeFileSync(join(pluginDir, 'upstream.json'), `${JSON.stringify(meta, null, 2)}\n`)

  return { version, conflicts, added }
}

function printList(title: string, items: string[]): void {
  if (items.length === 0) return
  console.log(`${title}:`)
  for (const item of items) console.log(`  - ${item}`)
}

function check(repoRoot: string, dir: string): number {
  const version = readVersion(dir)
  if (version === null) throw new Error(`公式の版を読み取れません: ${dir}`)
  const upstreamDir = join(repoRoot, 'upstream', 'discord')
  const { changed, added } = compareDirs(upstreamDir, dir)
  console.log(`取り込み済みの版: ${readVersion(upstreamDir) ?? '不明'}`)
  console.log(`公式の版: ${version}`)
  if (changed.length === 0 && added.length === 0) console.log('追跡対象に差分はありません。')
  printList('変更された追跡対象', changed)
  printList('新しく現れたファイル (取り込むかどうかを判断してください)', added)
  return 0
}

function merge(repoRoot: string, dir: string): number {
  const { version, conflicts, added } = mergeUpstream({ repoRoot, newDir: dir })
  console.log(`公式 ${version} を取り込みました。`)
  console.log('plugin ディレクトリで bun install を実行して、bun.lock と依存を整えてください。')
  printList('新しく現れたファイル (取り込むかどうかを判断してください)', added)
  if (conflicts.length === 0) return 0
  printList('衝突したファイル (plugin 側に衝突マーカーを残したので解消してください)', conflicts)
  return 1
}

function main(args: string[]): number {
  const [command, dirArg] = args
  if (command !== 'check' && command !== 'merge') {
    console.error('使い方: bun tools/upstream.ts <check|merge> [公式の discord ディレクトリ]')
    return 1
  }
  const dir = dirArg ?? defaultCloneDir(process.env)
  const repoRoot = join(import.meta.dir, '..')
  try {
    return command === 'check' ? check(repoRoot, dir) : merge(repoRoot, dir)
  } catch (error) {
    console.error(`エラー: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))
