// 互換 shim
// global settings.json の statusLine が指す symlink の参照先である
// footer は proxy が transcript と使用量キャッシュから組み立てるようになり tee による保存は不要になった
// 移行手順で statusLine を本来のコマンドへ戻した後 次のリリースでこのファイルを削除する
// ここでは stdin をそのまま本来のコマンドへ渡すだけにする
// 使い方: bun statusline-tee.ts <本来のコマンド> [args...]
import { spawn } from 'child_process'

const raw = await new Response(Bun.stdin.stream()).text()

const cmd = process.argv[2]
if (cmd) {
  const child = spawn(cmd, process.argv.slice(3), { stdio: ['pipe', 'inherit', 'inherit'] })

  // ラップ先コマンドが見つからない場合 (ENOENT) や他のエラーで shim が落ちるのを防ぐ
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
