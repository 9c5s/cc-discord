import { basename } from 'path'

// 絵文字を含む全体を 1 行ならインラインコード、複数行ならコードブロックで囲む。
function code(body: string): string {
  return body.includes('\n') ? `\`\`\`\n${body}\n\`\`\`` : `\`${body}\``
}

// tool_input から代表的な引数を1つ選び、絵文字とツール名と本文をまとめてコード整形する。
// file_path/pattern は1行(`🔧 Edit watch.ts`)、bash はツール名と本文の間で改行しコードブロックにする。
// bash の内容は省略しない。hideBody が true なら本文を出さずツール名のみにする。
export function toolSummary(name: string, input: Record<string, unknown>, hideBody = false): string {
  if (hideBody) return code(`🔧 ${name}`)
  const fp = input.file_path ?? input.path ?? input.notebook_path
  if (typeof fp === 'string') return code(`🔧 ${name} ${basename(fp.replace(/\\/g, '/'))}`)
  const cmd = input.command
  if (typeof cmd === 'string') return code(`🔧 ${name}\n${cmd}`)
  const pat = input.pattern
  if (typeof pat === 'string') return code(`🔧 ${name}: ${pat}`)
  return code(`🔧 ${name}`)
}

// thinking の先頭1〜2文を要点として抽出(最大200字)。
export function thinkingGist(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  const sentences = trimmed.split(/(?<=[。．.!?！?])/).filter(Boolean)
  let gist = (sentences[0] ?? '') + (sentences[1] ?? '')
  if (gist.length > 196) gist = gist.slice(0, 196) + '…'
  if (!gist) return '' // 空入力は空文字を返し呼び出し元が skip できる
  return `🧠 ${gist}`.trim()
}

// inbound 本文と受信時刻から進捗スレッドの名前を生成する。
// [MM/DD HH:MM] のプレフィックスを付け、本文は連続空白を空白1つに正規化する。
// 80字を超える本文は79字に切り末尾に … を付ける。本文が空なら progress とする。
export function threadName(content: string, date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  const body = content.replace(/\s+/g, ' ').trim()
  const clipped = body.length > 80 ? body.slice(0, 79) + '…' : body
  return `[${stamp}] ${clipped || 'progress'}`
}
