import { closeSync, fstatSync, openSync, readSync } from 'fs'
import { buildStatusBlock, modelUsageSuffix, readBranch } from './status'
import type { UsageSnapshot } from './usage'

// reply 末尾の footer 組み立て ---
// statusline の stdin JSON に依存せず 現行 activation の transcript と使用量 API の値から組み立てる
// transcript が取れない場合はモデル行と ctx を省き ブランチと使用量だけで作る

// transcript は末尾だけ読む (長い会話でも一定コストにする)
const TAIL_BYTES = 512 * 1024
// ctx% の分母とする context window
const CONTEXT_WINDOW = 1_000_000

type J = Record<string, unknown>
const obj = (v: unknown): J | null => (typeof v === 'object' && v !== null ? (v as J) : null)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

// transcript の末尾を読む
// 上限を超えるファイルでは先頭の不完全な行を捨てる
// 改行が 1 つも無い (単一行が上限を超える) 場合は空を返し 呼び出し側でモデル行と ctx を省かせる
export function readTranscriptTail(path: string, maxBytes = TAIL_BYTES): string | null {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const start = Math.max(0, size - maxBytes)
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    const text = buf.toString('utf8')
    if (start === 0) return text
    const nl = text.indexOf('\n')
    return nl < 0 ? '' : text.slice(nl + 1)
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // 閉じられなくても読み取り結果には影響しない
      }
    }
  }
}

export type AssistantEntry = { model: string; effort: string | null; tokens: number }

// transcript の末尾から直前ターンの assistant エントリを取る
// 行を逆順に走査し 合成モデル (<synthetic>) と usage を持たないエントリは飛ばす
export function readLastAssistantEntry(path: string): AssistantEntry | null {
  const text = readTranscriptTail(path)
  if (text === null) return null
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    let e: J | null
    try {
      e = obj(JSON.parse(line))
    } catch {
      continue
    }
    if (!e || e.type !== 'assistant') continue
    const msg = obj(e.message)
    if (!msg || typeof msg.model !== 'string' || msg.model === '<synthetic>') continue
    const usage = obj(msg.usage)
    if (!usage) continue
    return {
      model: msg.model,
      effort: typeof e.effort === 'string' && e.effort ? e.effort : null,
      tokens: num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens),
    }
  }
  return null
}

// モデル id を表示名にする
// claude-<family>-<major>[-<minor>] の形なら family を先頭大文字にして major.minor を付ける
// 規約から外れた id はそのまま使う
// context window の広さは表示名に出さない (ctx% の分母にだけ効かせる)
export function modelDisplayName(modelId: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(modelId)
  if (!m) return modelId
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1)
  return `${family} ${m[3] ? `${m[2]}.${m[3]}` : m[2]}`
}

// footer を末尾チャンクへ結合する
// 改行 1 つを挟んで収まるなら結合し 収まらなければ独立したチャンクとして足す
export function attachFooter(chunks: string[], footer: string, limit: number): string[] {
  if (!footer) return chunks
  const out = [...chunks]
  const last = out.length > 0 ? out[out.length - 1] : ''
  if (out.length > 0 && last.length + 1 + footer.length <= limit) {
    out[out.length - 1] = `${last}\n${footer}`
    return out
  }
  out.push(footer)
  return out
}

// footer を組み立てる
// 全要素が欠けたら空文字を返し 呼び出し側が付与をスキップする
export function buildFooter(input: {
  transcriptPath: string | null
  ownerDir: string | null
  usage: UsageSnapshot
  notice?: string | null
  env?: NodeJS.ProcessEnv
}): string {
  const env = input.env ?? process.env
  const entry = input.transcriptPath ? readLastAssistantEntry(input.transcriptPath) : null

  const data: J = {}
  if (entry) {
    data.model = { display_name: modelDisplayName(entry.model) }
    // effort はモデル名と同じ行にしか出ないため モデルが取れないときは effort も出ない
    const effort = entry.effort ?? env.CLAUDE_EFFORT
    if (effort) data.effort = { level: effort }
    data.context_window = { used_percentage: Math.floor((entry.tokens / CONTEXT_WINDOW) * 100) }
  }
  const rateLimits: J = {}
  if (input.usage.session) rateLimits.five_hour = input.usage.session
  if (input.usage.weekly) rateLimits.seven_day = input.usage.weekly
  if (Object.keys(rateLimits).length > 0) data.rate_limits = rateLimits

  return buildStatusBlock(
    data,
    input.ownerDir ? readBranch(input.ownerDir) : null,
    modelUsageSuffix(input.usage.modelScoped),
    input.notice,
  )
}
