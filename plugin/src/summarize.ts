import { basename } from 'path'

// 絵文字を含む全体を 1 行ならインラインコード、複数行ならコードブロックで囲む。
function code(body: string): string {
  return body.includes('\n') ? `\`\`\`\n${body}\n\`\`\`` : `\`${body}\``
}

// バックスラッシュ区切りにも対応してパスからファイル名を取り出す
function fileName(p: string): string {
  return basename(p.replace(/\\/g, '/'))
}

// 補足情報として拾う引数キーの優先順。前方ほど短い要約に向くキーを置き、
// prompt/plan/text のような長文キーは後方に置く。
// path は Grep/Glob で pattern と同居するため pattern より後にする。
const DETAIL_KEYS = [
  'command', 'pattern', 'path', 'description', 'skill', 'query', 'url',
  'to', 'reason', 'subject', 'name', 'emoji', 'prompt', 'plan', 'text',
] as const

// 100 コードポイントを超える文字列は 100 で切り捨て … を付ける。
// サロゲートペアを分断しないよう code point 単位で数える。
function truncate(s: string): string {
  const points = [...s]
  return points.length > 100 ? points.slice(0, 100).join('') + '…' : s
}

// tool_input から補足情報を1つ選ぶ。string 引数を DETAIL_KEYS の優先順で探し、
// 無ければ配列系の files/questions/todos から要約を作る。
function pickDetail(input: Record<string, unknown>): { key: string; value: string } | undefined {
  for (const key of DETAIL_KEYS) {
    const v = input[key]
    if (typeof v === 'string' && v.trim()) return { key, value: v }
  }
  const { files, questions, todos } = input
  if (Array.isArray(files) && files.length > 0 && files.every((f): f is string => typeof f === 'string')) {
    return { key: 'files', value: files.map(fileName).join(', ') }
  }
  if (Array.isArray(questions)) {
    const q = (questions[0] as Record<string, unknown> | undefined)?.question
    if (typeof q === 'string' && q.trim()) return { key: 'questions', value: q }
  }
  if (Array.isArray(todos)) {
    const active = todos.find(
      (t) => (t as Record<string, unknown> | null)?.status === 'in_progress',
    ) as Record<string, unknown> | undefined
    const form = active?.activeForm
    return { key: 'todos', value: typeof form === 'string' && form.trim() ? form : `${todos.length}件` }
  }
  return undefined
}

// tool_input から代表的な引数を1つ選び、絵文字とツール名と本文をまとめてコード整形する。
// どのキーも `⚙️ ツール名 補足` の空白区切り1行(`⚙️ Edit watch.ts` / `⚙️ Agent ログ調査`)とするが、
// command と改行入り・100字超の本文はツール名の後で改行しコードブロックにする。
// 100字を超える本文は100字で切り捨て … を付ける。hideBody が true なら本文を出さずツール名のみにする。
export function toolSummary(name: string, input: Record<string, unknown>, hideBody = false): string {
  if (hideBody) return code(`⚙️ ${name}`)
  const fp = input.file_path ?? input.notebook_path ?? input.scriptPath
  if (typeof fp === 'string') return code(`⚙️ ${name} ${fileName(fp)}`)
  const detail = pickDetail(input)
  if (!detail) return code(`⚙️ ${name}`)
  const body = truncate(detail.value)
  if (detail.key === 'command' || body !== detail.value || body.includes('\n')) {
    return code(`⚙️ ${name}\n${body}`)
  }
  return code(`⚙️ ${name} ${body}`)
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
