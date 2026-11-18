import { thinkingGist, toolSummary, truncate } from './summarize'
import { statSync, openSync, readSync, closeSync, existsSync } from 'fs'
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
// 送信側は 1900 字で切り捨てるため まとめ送信が長くなるとコードブロックの終端ごと
// 失われて表示が壊れる
// これを防ぐためメッセージ境界で送信単位を分割する
// 単一メッセージが maxLen を超える場合はそのまま 1 チャンクにする (送信側の切り捨てが最終安全弁)
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

// transcript の増分の読み取り ---

export type TailReader = { readNewLines(): string[] }

// 作成時点の末尾 (ファイルが無ければ先頭) から 追記された完結した行を返す
// ファイルが縮んだら truncate とみなし 持ち越した行の断片と decoder の部分バイトを捨てて先頭から読み直す
export function createTailReader(path: string): TailReader {
  let offset = existsSync(path) ? statSync(path).size : 0
  let carry = ''
  let decoder = new StringDecoder('utf8')

  return {
    readNewLines(): string[] {
      if (!existsSync(path)) return []
      const size = statSync(path).size
      if (size < offset) {
        offset = 0
        carry = ''
        decoder = new StringDecoder('utf8')
      }
      if (size === offset) return []
      const fd = openSync(path, 'r')
      let chunk = ''
      try {
        // readSync は要求より少なく読むことがある (同時更新中の transcript との競合)
        const buf = Buffer.alloc(size - offset)
        const bytesRead = readSync(fd, buf, 0, buf.length, offset)
        offset += bytesRead
        chunk = decoder.write(buf.subarray(0, bytesRead))
      } finally {
        closeSync(fd)
      }
      const result = splitLines(carry, chunk)
      carry = result.carry
      return result.lines
    },
  }
}
