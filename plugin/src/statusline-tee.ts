// Claude Code の statusLine コマンドをラップする tee スクリプト
// stdin の statusline JSON を stateDir に保存し 整形済みステータスブロック (.txt) を生成した上で
// 本来の statusline コマンドへパススルーする
// .txt は discord プラグイン server.ts (patch) が
// reply 末尾に付与するために読む
// 整形ロジックは status.ts に置き patch 側を最小に保つ
// 使い方: bun statusline-tee.ts <本来のコマンド> [args...]
import { spawn } from 'child_process'
import { mkdirSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { stateDir } from './routes'
import { ownerFromDir } from './normalize'
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


// 同時読み取りに壊れたファイルを見せないため一時ファイル経由で置き換える
// 同じ owner の tee が並走しても衝突しないよう一時名に PID を含める
function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
}

// JSON 保存と整形済みブロック生成
// 失敗しても statusline 表示は止めない
try {
  const data = JSON.parse(raw) as Record<string, unknown>
  const pd = projectDir(data)
  const owner = pd ? ownerFromDir(pd) : ''
  if (owner) {
    const dir = join(stateDir(), 'statusline')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeAtomic(join(dir, `${owner}.json`), raw)
    writeAtomic(join(dir, `${owner}.txt`), buildStatusBlock(data, readBranch(pd)))
  }
} catch (err) {
  // 保存失敗は無視して表示を優先するが DEBUG 設定時は診断を出す
  if (process.env.DISCORD_NOTIFY_DEBUG) {
    process.stderr.write(`[statusline-tee] save error: ${(err as Error).message}\n`)
  }
}

// 本来の statusline コマンドへパススルーする
const cmd = process.argv[2]
if (cmd) {
  const child = spawn(cmd, process.argv.slice(3), { stdio: ['pipe', 'inherit', 'inherit'] })

  // ラップ先コマンドが見つからない場合 (ENOENT) や他のエラーで tee が落ちるのを防ぐ
  child.on('error', (err) => {
    process.stderr.write(`[statusline-tee] passthrough failed: ${(err as Error).message}\n`)
    process.exit(1)
  })

  // stdin への書き込み時の EPIPE エラーで即死するのを防ぐ
  child.stdin.on('error', () => {})

  child.stdin.write(raw)
  child.stdin.end()
  child.on('exit', (code) => process.exit(code ?? 0))
} else {
  // ラップ対象が未指定だと statusline 表示自体が出なくなる
  // 設定ミスに早期に気付けるよう警告を出す
  process.stderr.write('[statusline-tee] no passthrough command specified\n')
}
