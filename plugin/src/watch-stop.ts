// SessionEnd hook. このセッションの transcript を監視している watch を停止する
// stdin の JSON から transcript_path を読み pidFile のプロセスのコマンドラインに
// その transcript が含まれる場合のみ SIGTERM を送る
// 別セッションに takeover 済みの watcher (コマンドラインの transcript が異なる) は巻き込まない
import { readFileSync, unlinkSync } from 'fs'
import { join, basename } from 'path'
import { execFileSync } from 'child_process'
import { stateDir } from './routes'
import { ownerName } from './notify'

const raw = await new Response(Bun.stdin.stream()).text()
let tp = ''
try {
  const payload = JSON.parse(raw) as Record<string, unknown>
  tp = typeof payload.transcript_path === 'string' ? payload.transcript_path : ''
} catch { /* parse 失敗は何もしない */ }

const owner = ownerName()
if (tp && owner) {
  const pidFile = join(stateDir(), `watch-${owner}.pid`)
  try {
    const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
    if (!isNaN(pid)) {
      // watcher のコマンドラインにこのセッションの transcript ファイル名が含まれるか確認する
      // windowsHide は SessionEnd hook も状況によっては console 無し状態で実行されうるため
      // 念のため明示する watch.ts 側と同じ理由
      const out = process.platform === 'win32'
        ? execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8', timeout: 5000, windowsHide: true })
        : execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8', timeout: 3000 })
      if (out.toLowerCase().includes(basename(tp).toLowerCase())) {
        try { process.kill(pid, 'SIGTERM') } catch { /* 既に終了済みは無視する */ }
        // Windows では watcher 側の SIGTERM ハンドラが走らないため pidFile をここで掃除する
        // POSIX は watcher 自身が中身一致を確認して削除するため触らない
        // 新しい watcher が書き直した pidFile を消さないよう 中身が kill 対象の PID のままのときだけ削除する
        if (process.platform === 'win32') {
          try {
            if (readFileSync(pidFile, 'utf8').trim() === String(pid)) unlinkSync(pidFile)
          } catch { /* 読み取りや削除の失敗は無視する */ }
        }
      }
    }
  } catch { /* pidFile 不在やプロセス確認失敗は何もしない */ }
}
