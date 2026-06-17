import { thinkingGist, toolSummary, truncate } from './summarize'
import { sendNow, ownerName, debugLog } from './notify'
import { stateDir } from './routes'
import { statSync, openSync, readSync, closeSync, existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { StringDecoder } from 'string_decoder'

// JSONL の1行から転送すべきメッセージ配列を返す純粋関数
// 空行/parse 失敗/非 assistant 行/content が配列でない場合は空配列を返す
export function extractMessages(line: string): string[] {
  if (!line.trim()) return []
  let rec: unknown
  try { rec = JSON.parse(line) } catch { return [] }
  if (typeof rec !== 'object' || rec === null) return []
  const r = rec as Record<string, unknown>
  if (r.type !== 'assistant') return []
  const msg = r.message
  if (typeof msg !== 'object' || msg === null) return []
  const content = (msg as Record<string, unknown>).content
  if (!Array.isArray(content)) return []

  const results: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as Record<string, unknown>
    if (b.type === 'thinking' && typeof b.thinking === 'string') {
      // 注: 現環境では thinking が署名付きで transcript に本文が記録されず
      // thinking が空文字になるため ここは実質 no-op となる (2026-05-27 検証で判明)
      // 将来 Claude Code が thinking 本文を記録する版に備えてコードは残す
      // thinkingGist が空文字 (空入力) を返す場合は追加しない
      const gist = thinkingGist(b.thinking)
      if (gist) results.push(gist)
    } else if (b.type === 'text' && typeof b.text === 'string') {
      const t = b.text.trim()
      if (!t) continue
      // resume 時に Claude が出す定型応答は Discord に流さない
      if (t === 'No response requested.') continue
      // truncate でコードポイント単位に 1800 字で切り詰める
      results.push('💬 ' + truncate(t, 1800))
    } else if (b.type === 'tool_use' && typeof b.name === 'string') {
      // tool_use も transcript から拾って同一経路で送る
      // PreToolUse hook 経由の即時送信は
      // assistant message の transcript 書き込みより早く発火するため text と並びが逆転する
      // watch 一本化することで JSONL の content 順を Discord 表示順に保つ
      const input = (typeof b.input === 'object' && b.input !== null) ? b.input as Record<string, unknown> : {}
      results.push(toolSummary(b.name, input))
    }
    // その他のブロックはスキップする
  }
  return results
}

// メッセージ配列を改行結合で maxLen 以下のチャンク列に詰める
// notify 側は 1900 字で切り捨てるため まとめ送信が長くなるとコードブロックの終端ごと
// 失われて表示が壊れる
// これを防ぐためメッセージ境界で送信単位を分割する
// 単一メッセージが maxLen を超える場合はそのまま 1 チャンクにする (notify 側の切り捨てが最終安全弁)
export function packMessages(messages: string[], maxLen = 1900): string[] {
  const chunks: string[] = []
  let cur = ''
  for (const m of messages) {
    if (!cur) cur = m
    else if (cur.length + 1 + m.length <= maxLen) cur += '\n' + m
    else {
      chunks.push(cur)
      cur = m
    }
  }
  if (cur) chunks.push(cur)
  return chunks
}

// 行分割ロジックを純粋関数に抽出する
// carry と読み取りチャンクを結合し改行で分割する
// 未完の最終行を次回へ持ち越す
export function splitLines(carry: string, chunk: string): { lines: string[]; carry: string } {
  const combined = carry + chunk
  const parts = combined.split('\n')
  const newCarry = parts.pop() ?? ''
  return { lines: parts, carry: newCarry }
}

// このファイルが直接実行された場合のみ常駐ループを起動する
// テストからインポートされた場合は実行しない
if (import.meta.main) {
  const transcriptPath = process.argv[2]
  // owner 未解決 (routing 対象外) または transcript_path 引数なしなら即終了する
  // 注: channelId(routes) はここでは見ない
  // channel server の ready で routes が
  // 書かれるまで起動レースになり 見てしまうと watch が即死して以降の途中経過が
  // 一切出なくなる
  // owner さえあれば常駐し routes 書き込み後に notify が channelId を
  // 解決して送信する (routes 未解決の間は notify 側で送信スキップされるだけ)
  if (!transcriptPath || !ownerName()) process.exit(0)

  // 既存分はスキップし 以降の新規行を追う
  let offset = existsSync(transcriptPath) ? statSync(transcriptPath).size : 0
  let carry = ''
  // 読取境界が UTF-8 マルチバイト列の途中に落ちても化けないよう
  // ポーリングを跨いで部分バイト列を保持する decoder を使う
  let decoder = new StringDecoder('utf8')

  // 全サイクル横断の単一送信チェーン
  // 同一ポーリングサイクル内だけでなく サイクル間も直列化して Discord の表示順を保証する
  // catch の後も次の then が動くことでチェーンが壊れないよう設計する
  let sendChain: Promise<void> = Promise.resolve()

  // transcript JSONL を 250ms ごとにポーリングし新規行を処理する
  function poll() {
    try {
      if (!existsSync(transcriptPath)) return
      const size = statSync(transcriptPath).size
      // ローテーション/truncate を検出したら読取状態と decoder の部分バイトを破棄する
      if (size < offset) { offset = 0; carry = ''; decoder = new StringDecoder('utf8') }
      if (size === offset) return
      const fd = openSync(transcriptPath, 'r')
      let chunk = ''
      try {
        // readSync は要求より少なく読むことがある (同時更新中の transcript との競合)
        // 実読取量で offset を進め decode も実読取ぶんに限定しないと増分を取りこぼす
        const buf = Buffer.alloc(size - offset)
        const bytesRead = readSync(fd, buf, 0, buf.length, offset)
        offset += bytesRead
        // decoder.write はマルチバイト途中の末尾バイトを内部に保持し次回へ繋ぐ
        chunk = decoder.write(buf.subarray(0, bytesRead))
      } finally {
        // readSync が throw しても fd を確実に閉じてリークを防ぐ
        closeSync(fd)
      }
      // 純粋関数 splitLines で行分割する
      const result = splitLines(carry, chunk)
      carry = result.carry
      const lines = result.lines

      // 抽出件数を DEBUG で可視化する (transcript フォーマット変更による全行 parse 失敗の検知手段)
      const messages: string[] = []
      for (const line of lines) {
        for (const msg of extractMessages(line)) messages.push(msg)
      }
      if (messages.length > 0) {
        debugLog(`poll: ${lines.length} lines -> ${messages.length} msgs`)
        const chunks = packMessages(messages)
        // 全サイクル横断で直列化する
        // sendChain に then で繋ぐことで前サイクルの送信完了後に次サイクルの送信が始まる
        // catch で rejection を捕捉して debugLog に出すことでチェーンが壊れず常駐が継続する
        sendChain = sendChain
          .then(async () => { for (const c of chunks) await sendNow(c) })
          .catch((e) => debugLog(`send failed: ${e}`))
      }
    } catch (e) {
      // セッションは止めない
      // DEBUG 時のみログに出す
      debugLog(`[watch] ${e}`)
    }
  }

  // PID ファイルで孤児プロセスを掃除する
  // 同じオーナーの前回 watch が残っていれば SIGTERM で終了させ 自分の PID を書き込む
  // watch は owner 単位で1本のみ動かす設計である
  // 同一プロジェクトでセッションが並走した場合は
  // 最後に起動したセッションだけが進捗転送され 先発セッションの転送は引き継ぎで停止する
  const pidFile = join(stateDir(), 'watch-' + ownerName() + '.pid')

  // PID が watch.ts を実行中のプロセスかをコマンドラインで確認する
  // 実行ファイル名 (bun) だけの判定では PID 再利用先が別用途の bun だった場合に誤殺するため
  // コマンドライン引数に watch.ts が含まれることまで検証する
  // Windows は PowerShell の CIM を使う (wmic は Windows 11 25H2 で削除されるため依存しない)
  // 確認に失敗した場合 (プロセス不在を含む) は false を返し kill しない方向に倒す
  // windowsHide は watch.ts 自身が detached かつ console 無しで起動するため
  // 明示しないと PowerShell が新規コンソール窓を割り当てて一瞬フラッシュする
  function isWatchProcess(pid: number): boolean {
    try {
      const out = process.platform === 'win32'
        ? execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8', timeout: 5000, windowsHide: true })
        : execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8', timeout: 3000 })
      return out.toLowerCase().includes('watch.ts')
    } catch {
      return false
    }
  }
  try {
    // stateDir が未作成の環境では pidFile の書き込みが無音で失敗する
    // 書き込み前に stateDir を作成して多重起動防止が無効化される問題を防ぐ
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 })
  } catch (e) {
    debugLog(`[watch] mkdirSync stateDir failed: ${e}`)
  }
  try {
    if (existsSync(pidFile)) {
      const oldPid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
      if (!isNaN(oldPid) && oldPid !== process.pid && isWatchProcess(oldPid)) {
        try { process.kill(oldPid, 'SIGTERM') } catch { /* 既に終了済み or 権限なしは無視する */ }
      }
    }
  } catch { /* PID ファイル読み取りエラーは無視する */ }
  try {
    writeFileSync(pidFile, String(process.pid), { encoding: 'utf8', mode: 0o600 })
  } catch (e) {
    debugLog(`[watch] pidFile write failed: ${e}`)
  }

  // 同時起動の競合対策 (takeover 方式の補完)
  // pidFile の獲得は read-then-write で原子的でないため ほぼ同時に起動した 2 プロセスが
  // どちらも生き残り重複送信する余地がある
  // wx 排他は「最後に起動したセッションが引き継ぐ」設計と逆の優先順位になるため採らず
  // 書き込みから少し置いて pidFile を読み直し 自分以外の PID なら新しい watch に譲って退出する
  // (1.5 秒より遅れて起動した競合相手はコマンドライン検証付きの SIGTERM 経路で自分を終了させる)
  setTimeout(() => {
    try {
      if (readFileSync(pidFile, 'utf8').trim() !== String(process.pid)) {
        debugLog('[watch] superseded by a newer watcher, exiting')
        process.exit(0)
      }
    } catch { /* 読めない場合は継続する */ }
  }, 1500)

  // 250ms: 知覚的に即時 CPU/API レート制限とも余裕 (statSync 約1ms を 4回/秒)
  // これより短くするなら fs.watch への切替を検討する
  const interval = setInterval(poll, 250)
  // interval.unref() を呼ばない -- イベントループを保持して常駐する

  // SIGTERM ハンドラ
  // 注: Windows では process.kill が TerminateProcess 相当であり SIGTERM ハンドラは発火しない
  // このハンドラは POSIX 専用のクリーンアップである
  process.on('SIGTERM', () => {
    clearInterval(interval)
    // pidFile を読み直して中身が自分の PID と一致するときのみ削除する
    // 世代跨ぎで新 watch の pidFile を消す race を防ぐ
    try {
      const current = readFileSync(pidFile, 'utf8').trim()
      if (current === String(process.pid)) unlinkSync(pidFile)
    } catch { /* 削除失敗は無視する */ }
    process.exit(0)
  })
  // process.stdin.on('close', ...) は削除する
  // stdio:'ignore' で stdin が即 close するため 残すと起動直後に即終了してしまう
}
