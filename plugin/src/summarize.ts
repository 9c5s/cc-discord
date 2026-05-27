import { basename } from 'path'

// 本文を 1 行ならインラインコード、複数行ならコードブロックで囲む。
function code(body: string): string {
  return body.includes('\n') ? `\n\`\`\`\n${body}\n\`\`\`` : `\`${body}\``
}

// tool_input から代表的な引数を1つ選び、ツール名と本文をまとめてコード整形する。
// 1行ならインライン(🔧 `Edit watch.ts`)、複数行ならコードブロックにする。bash の内容は省略しない。
export function toolSummary(name: string, input: Record<string, unknown>): string {
  const fp = input.file_path ?? input.path ?? input.notebook_path
  if (typeof fp === 'string') return `🔧 ${code(`${name} ${basename(fp.replace(/\\/g, '/'))}`)}`
  const cmd = input.command
  if (typeof cmd === 'string') return `🔧 ${code(`${name}: ${cmd}`)}`
  const pat = input.pattern
  if (typeof pat === 'string') return `🔧 ${code(`${name}: ${pat}`)}`
  return `🔧 ${code(name)}`
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
