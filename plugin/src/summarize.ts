import { basename } from 'path'

// ZWSP (U+200B) はコードブロック内の ``` の連なりを分断するために挟む不可視文字
const ZWSP = String.fromCharCode(0x200b)

// Discord メッセージ上限 2000 と notify 側の安全弁 slice(0,1900) に対し
// コードブロック装飾ぶんの余裕をみて command 本文は 1800 字を上限とする
const COMMAND_LIMIT = 1800
// command 以外の長文引数 (prompt/plan/text 等) の上限
const DETAIL_LIMIT = 200

// 絵文字を含む全体を 1行かつバッククォート無しならインラインコード それ以外はコードブロックで囲む
// 本文に ` があるとインラインコードの囲みが壊れるためブロックに逃がし
// ブロック内で終端と衝突する ``` の連なりは ZWSP を挟んで分断する
function code(body: string): string {
  if (!body.includes('\n') && !body.includes('`')) return `\`${body}\``
  return `\`\`\`\n${body.replaceAll('```', `\`${ZWSP}\`${ZWSP}\``)}\n\`\`\``
}

// バックスラッシュ区切りにも対応してパスからファイル名を取り出す
function fileName(p: string): string {
  return basename(p.replace(/\\/g, '/'))
}

// mcp__<server>__<tool> 形式のツール名を <server>:<tool> に短縮する
// それ以外のツール名はそのまま返す
function shortToolName(name: string): string {
  if (!name.startsWith('mcp__')) return name
  const parts = name.split('__')
  if (parts.length < 3) return name
  return `${shortServerName(parts[1])}:${parts.slice(2).join('__')}`
}

// mcp サーバー名の定型プレフィックスを剥いで短縮する
// plugin_<プラグイン名>_<サーバー名> はサーバー名のみ claude_ai_<コネクタ名> はコネクタ名のみ残す
function shortServerName(server: string): string {
  if (server.startsWith('plugin_')) {
    const rest = server.slice('plugin_'.length)
    const i = rest.lastIndexOf('_')
    return i >= 0 ? rest.slice(i + 1) : rest
  }
  if (server.startsWith('claude_ai_')) return server.slice('claude_ai_'.length)
  return server
}

// 補足情報として拾う引数キーの優先順
// 前方ほど短い要約に向くキーを置き
// prompt/plan/text のような長文キーは後方に置く
// path は Grep/Glob で pattern と同居するため pattern より後にする
const DETAIL_KEYS = [
  'command', 'pattern', 'path', 'description', 'skill', 'query', 'url',
  'to', 'reason', 'subject', 'name', 'emoji', 'prompt', 'plan', 'text',
] as const

// 補足を出すと直後の実投稿と内容が重複するツール (短縮名)
// discord:reply は text がそのまま返信として届くため 通知はツール名のみにする
const HIDE_BODY_TOOLS = new Set(['discord:reply'])

// limit コードポイントを超える文字列は切り捨てて ... を付ける
// サロゲートペアを分断しないよう code point 単位で数える
export function truncate(s: string, limit: number): string {
  const points = [...s]
  return points.length > limit ? points.slice(0, limit).join('') + '…' : s
}

// tool_input から補足情報を1つ選ぶ
// string 引数を DETAIL_KEYS の優先順で探し
// 無ければ配列系の files/questions/todos から要約を作る
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

// tool_input から代表的な引数を1つ選び 絵文字とツール名と本文をまとめてコード整形する
// どのキーも `⚙️[ツール名] 補足` の空白区切り1行 (`⚙️[Edit] watch.ts` / `⚙️[Agent] ログ調査`) とするが
// command と改行/バッククォート入りや上限超の本文はツール名の後で改行しコードブロックにする
// 本文の上限は command が 1800 字 その他は 200 字で 超過分は切り捨てて ... を付ける
// hideBody が true または HIDE_BODY_TOOLS のツールは本文を出さずツール名のみにする
// ZWSP 展開による超過を防ぐため最終ブロックが 1900 コードポイントを超える場合は本文を短縮する
export function toolSummary(name: string, input: Record<string, unknown>, hideBody = false): string {
  const n = shortToolName(name)
  if (hideBody || HIDE_BODY_TOOLS.has(n)) return code(`⚙️[${n}]`)
  const fp = input.file_path ?? input.notebook_path ?? input.scriptPath
  if (typeof fp === 'string') return code(`⚙️[${n}] ${fileName(fp)}`)
  const detail = pickDetail(input)
  if (!detail) return code(`⚙️[${n}]`)
  let body = truncate(detail.value, detail.key === 'command' ? COMMAND_LIMIT : DETAIL_LIMIT)
  if (detail.key === 'command' || body !== detail.value || body.includes('\n') || body.includes('`')) {
    const header = `⚙️[${n}]\n`
    let block = code(`${header}${body}`)
    let bodyPoints = [...body]
    // ZWSP 展開で 1900 を超える場合は本文を短縮するループ
    while (bodyPoints.length > 0 && [...block].length > 1900) {
      bodyPoints = bodyPoints.slice(0, -1)
      body = bodyPoints.length > 0 ? bodyPoints.join('') + '…' : ''
      block = code(`${header}${body}`)
    }
    return block
  }
  return code(`⚙️[${n}] ${body}`)
}

// thinking の先頭1から2文を要点として抽出 (最大200字)
export function thinkingGist(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  const sentences = trimmed.split(/(?<=[。．.!?！?])/).filter(Boolean)
  let gist = (sentences[0] ?? '') + (sentences[1] ?? '')
  const points = [...gist]
  if (points.length > 196) gist = points.slice(0, 196).join('') + '…'
  if (!gist) return '' // 空入力は空文字を返し呼び出し元が skip できる
  return `🧠 ${gist}`.trim()
}

// inbound 本文と受信時刻から進捗スレッドの名前を生成する
// [MM/DD HH:MM] のプレフィックスを付け 本文は連続空白を空白1つに正規化する
// 80文字を超える本文は79文字に切り末尾に ... を付ける
// 本文が空なら progress とする
export function threadName(content: string, date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  const body = content.replace(/\s+/g, ' ').trim()
  const points = [...body]
  const clipped = points.length > 80 ? points.slice(0, 79).join('') + '…' : body
  return `[${stamp}] ${clipped || 'progress'}`
}
