// SessionStart hook. stdin の JSON から transcript_path を取り出し watch.ts を background 起動する
import { spawn } from 'child_process'
import { join } from 'path'

const raw = await new Response(Bun.stdin.stream()).text()
let tp = ''
try {
  const payload = JSON.parse(raw) as Record<string, unknown>
  // 文字列以外 (object や number) が来ても spawn に渡さないよう型を検証する
  tp = typeof payload.transcript_path === 'string' ? payload.transcript_path : ''
  if (!tp) {
    // transcript_path が取れない場合は stderr に診断を出す
    // hook プロセスの stderr は Claude Code 側で観測可能である
    process.stderr.write('[watch-launch] transcript_path not found in hook payload\n')
  }
} catch (e) {
  process.stderr.write(`[watch-launch] failed to parse hook payload: ${e}\n`)
}
if (tp) {
  // watch.ts は同じ src ディレクトリにある
  // import.meta.dir で解決する (Windows でも確実)
  const watch = join(import.meta.dir, 'watch.ts')
  // process.execPath は現在の bun バイナリのフルパス
  // Windows で bun の PATH 解決に依存せず確実
  // windowsHide はセッション開始時に子プロセスのコンソール窓が一瞬出るのを抑止する (Windows 限定で有効)
  const child = spawn(process.execPath, [watch, tp], { detached: true, stdio: 'ignore', env: process.env, windowsHide: true })
  child.unref()
}
