import { basename } from 'path'

// tool_input から代表的な引数を1つ選んで1行に。
// 区切り文字で引数の種別を表現する。file_path 系はファイル名なのでスペース区切り(Read server.ts)、
// command/pattern は実行内容なのでコロン区切り(Bash: bun test)とする。
export function toolSummary(name: string, input: Record<string, unknown>): string {
  const fp = input.file_path ?? input.path ?? input.notebook_path
  if (typeof fp === 'string') return `🔧 ${name} ${basename(fp.replace(/\\/g, '/'))}`
  const cmd = input.command
  if (typeof cmd === 'string') return `🔧 ${name}: ${cmd.slice(0, 80)}`
  const pat = input.pattern
  if (typeof pat === 'string') return `🔧 ${name}: ${pat.slice(0, 80)}`
  return `🔧 ${name}`
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
