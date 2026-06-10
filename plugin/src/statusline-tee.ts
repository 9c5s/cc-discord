// Claude Code の statusLine コマンドをラップする tee スクリプト。
// stdin の statusline JSON を stateDir に保存し、整形済みステータスブロック(.txt)を生成した上で、
// 本来の statusline コマンドへパススルーする。.txt は discord プラグイン server.ts(patch)が
// reply 末尾に付与するために読む。整形ロジックは status.ts に置き patch 側を最小に保つ。
// 使い方: bun statusline-tee.ts <本来のコマンド> [args...]
import { spawn } from 'child_process'
import { mkdirSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { stateDir } from './routes'
import { normalizeName } from './normalize'
import { buildStatusBlock, readBranch } from './status'

const raw = await new Response(Bun.stdin.stream()).text()

// statusline JSON からプロジェクトディレクトリを解決する
function projectDir(data: Record<string, unknown>): string {
  const ws = data.workspace
  const pd = (typeof ws === 'object' && ws !== null)
    ? (ws as Record<string, unknown>).project_dir
    : undefined
  return typeof pd === 'string' && pd ? pd : (typeof data.cwd === 'string' ? data.cwd : '')
}

// プロジェクトディレクトリのベース名を正規化した所有者名にする
function ownerOf(dir: string): string {
  const base = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  return normalizeName(base)
}

// 同時読み取りに壊れたファイルを見せないため一時ファイル経由で置き換える
function writeAtomic(path: string, content: string): void {
  writeFileSync(path + '.tmp', content, 'utf8')
  renameSync(path + '.tmp', path)
}

// JSON 保存と整形済みブロック生成。失敗しても statusline 表示は止めない
try {
  const data = JSON.parse(raw) as Record<string, unknown>
  const pd = projectDir(data)
  const owner = pd ? ownerOf(pd) : ''
  if (owner) {
    const dir = join(stateDir(), 'statusline')
    mkdirSync(dir, { recursive: true })
    writeAtomic(join(dir, `${owner}.json`), raw)
    writeAtomic(join(dir, `${owner}.txt`), buildStatusBlock(data, readBranch(pd)))
  }
} catch { /* 保存失敗は無視して表示を優先する */ }

// 本来の statusline コマンドへパススルーする
const cmd = process.argv[2]
if (cmd) {
  const child = spawn(cmd, process.argv.slice(3), { stdio: ['pipe', 'inherit', 'inherit'] })
  child.stdin.write(raw)
  child.stdin.end()
  child.on('exit', (code) => process.exit(code ?? 0))
}
