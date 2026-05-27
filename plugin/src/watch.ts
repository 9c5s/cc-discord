import { thinkingGist } from './summarize'
import { enqueue, channelId } from './notify'
import { statSync, openSync, readSync, closeSync, existsSync } from 'fs'

// JSONL の1行から転送すべきメッセージ配列を返す純粋関数
// 空行・parse 失敗・非 assistant 行・content が配列でない場合は空配列を返す
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
      // thinkingGist が空文字(空入力)を返す場合は追加しない
      const gist = thinkingGist(b.thinking)
      if (gist) results.push(gist)
    } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      results.push('💬 ' + b.text.trim().slice(0, 1800))
    }
    // tool_use やその他のブロックはスキップする
  }
  return results
}

// このファイルが直接実行された場合のみ常駐ループを起動する
// テストからインポートされた場合は実行しない
if (import.meta.main) {
  const transcriptPath = process.argv[2]
  // 担当チャンネルなし、または transcript_path 引数なしなら即終了する
  if (!transcriptPath || !channelId()) process.exit(0)

  // 既存分はスキップし、以降の新規行を追う
  let offset = existsSync(transcriptPath) ? statSync(transcriptPath).size : 0
  let carry = ''

  // transcript JSONL を 1 秒おきにポーリングし新規行を処理する
  function poll() {
    try {
      if (!existsSync(transcriptPath)) return
      const size = statSync(transcriptPath).size
      if (size <= offset) return
      const fd = openSync(transcriptPath, 'r')
      const buf = Buffer.alloc(size - offset)
      readSync(fd, buf, 0, buf.length, offset)
      closeSync(fd)
      offset = size
      carry += buf.toString('utf8')
      const lines = carry.split('\n')
      carry = lines.pop() ?? '' // 未完行は次回へ持ち越す
      for (const line of lines) {
        for (const msg of extractMessages(line)) enqueue(msg)
      }
    } catch (e) {
      // セッションは止めない。DEBUG 時のみ stderr に出す
      if (process.env.DISCORD_NOTIFY_DEBUG) process.stderr.write(`[watch] ${e}\n`)
    }
  }

  const interval = setInterval(poll, 1000)
  // watch 常駐でも本体プロセスを待機させない
  interval.unref?.()
  process.on('SIGTERM', () => { clearInterval(interval); process.exit(0) })
  process.stdin.on('close', () => { clearInterval(interval); process.exit(0) })
}
