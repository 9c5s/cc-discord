import { readFileSync } from 'fs'
import { join, resolve } from 'path'

// statusline JSON からリプライ末尾に付ける3行ステータスブロックを構築するモジュール
// statusline-tee.ts が書き込み discord プラグイン server.ts (patch) が読んで reply 末尾に付ける

type J = Record<string, unknown>
const obj = (v: unknown): J | null => (typeof v === 'object' && v !== null ? (v as J) : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

// .git/HEAD からブランチ名を読む
// subprocess を使わずファイル直読みで済ませる
// detached HEAD は短縮ハッシュを返し .git がファイルの worktree 形式は gitdir 参照を辿る
// gitdir が相対パスの場合は projectDir 基準で解決する (submodule の標準形式に対応)
export function readBranch(projectDir: string): string | null {
  try {
    const gitPath = join(projectDir, '.git')
    let head: string
    try {
      head = readFileSync(join(gitPath, 'HEAD'), 'utf8')
    } catch {
      const m = readFileSync(gitPath, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m)
      if (!m) return null
      head = readFileSync(join(resolve(projectDir, m[1]), 'HEAD'), 'utf8')
    }
    const ref = head.trim()
    const m = ref.match(/^ref:\s*refs\/heads\/(.+)$/)
    if (m) return m[1]
    return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 7) : null
  } catch {
    return null
  }
}

const pad = (n: number) => String(n).padStart(2, '0')

// リセット時刻のローカル表記
// 5h 用は "H:MM", 7d 用は "M/D H:MM" (0埋めなし)
function resetTime(ts: number): string {
  const d = new Date(ts * 1000)
  return `${d.getHours()}:${pad(d.getMinutes())}`
}
function resetDate(ts: number): string {
  const d = new Date(ts * 1000)
  return `${d.getMonth() + 1}/${d.getDate()} ${resetTime(ts)}`
}

// rate_limits の1バケット (five_hour/seven_day) を "⏰ 63% 19:10" 形式にする
// アイコンが 5h/7d のラベルを兼ねる
function rateSeg(rl: J | null, key: string, icon: string, fmt: (ts: number) => string): string | null {
  const b = obj(rl?.[key])
  if (!b) return null
  const pct = num(b.used_percentage)
  if (pct === null) return null
  const ts = num(b.resets_at)
  return ts === null ? `${icon} ${Math.round(pct)}%` : `${icon} ${Math.round(pct)}% ${fmt(ts)}`
}

// ステータスブロック本体
// 3行構成で 取得できない要素は行ごと/要素ごとに省く
// 各項目はテキストラベルの代わりに絵文字を頭に付ける (コードブロック内で安定表示する世代を選定済み)
// 1行目: 🌿 ブランチ名
// 2行目: 👾 モデル名 | 🧠 <effort level>
// 3行目: 📊 <ctx使用率>% | ⏰ <5h使用率>% <リセット> | 📅 <7d使用率>% <リセット>
// 全行が欠けるときは空文字を返し 呼び出し側が付与をスキップできるようにする
export function buildStatusBlock(data: J, branch: string | null): string {
  const lines: string[] = []
  if (branch) lines.push(`🌿 ${branch}`)

  // display_name 末尾の "(NM context)" は冗長なので "(NM)" に短縮する
  // statusline.py 側 _seg_model も同じ短縮を入れている (画面表示との一貫性)
  // 末尾アンカー $ を付け display_name の中間に同じ部分文字列が混入した場合の誤置換を防ぐ
  // 通常モデル ("Opus 4.7" 等) は match しないためそのまま残る
  const model = str(obj(data.model)?.display_name)?.replace(/ context\)$/, ')') ?? null
  const effort = str(obj(data.effort)?.level)
  if (model) lines.push(effort ? `👾 ${model} | 🧠 ${effort}` : `👾 ${model}`)

  const parts: string[] = []
  const ctx = num(obj(data.context_window)?.used_percentage)
  if (ctx !== null) parts.push(`📊 ${Math.round(ctx)}%`)
  const rl = obj(data.rate_limits)
  const r5 = rateSeg(rl, 'five_hour', '⏰', resetTime)
  if (r5) parts.push(r5)
  const r7 = rateSeg(rl, 'seven_day', '📅', resetDate)
  if (r7) parts.push(r7)
  if (parts.length > 0) lines.push(parts.join(' | '))

  if (lines.length === 0) return ''
  return '```\n' + lines.join('\n') + '\n```'
}
