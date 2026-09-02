import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { buildStatusBlock, modelUsageSuffix, readBranch } from './status'
import { readCachedUsage, type UsageSnapshot } from './usage'

// reply 末尾の footer 組み立て ---
// statusline の stdin JSON に依存せず 現行 activation の transcript と使用量キャッシュから組み立てる
// transcript が取れない場合はモデル行と ctx を省き ブランチと使用量だけで作る

// transcript は末尾だけ読む (長い会話でも一定コストにする)
const TAIL_BYTES = 512 * 1024
// 既定の context window (settings の model に [1m] があるときだけ 1M にする)
const DEFAULT_CONTEXT_WINDOW = 200_000
const ONE_MILLION_CONTEXT_WINDOW = 1_000_000

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

// settings の model を local -> project -> user の順に探す
// 最初に見つかった値を採用する (見つからなければ null)
function settingsModel(ownerDir: string | null): string | null {
  const files: string[] = []
  if (ownerDir) {
    files.push(join(ownerDir, '.claude', 'settings.local.json'))
    files.push(join(ownerDir, '.claude', 'settings.json'))
  }
  files.push(join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json'))
  for (const f of files) {
    try {
      const model = obj(JSON.parse(readFileSync(f, 'utf8')))?.model
      if (typeof model === 'string' && model) return model
    } catch {
      // 読めない設定は無いものとして次を見る
    }
  }
  return null
}

// context window を settings の model から決める
// --model の CLI 指定は proxy から読めないため その場合は実際と異なる (既知の制限)
export function contextWindow(ownerDir: string | null): number {
  const model = settingsModel(ownerDir)
  return model?.endsWith('[1m]') ? ONE_MILLION_CONTEXT_WINDOW : DEFAULT_CONTEXT_WINDOW
}

// footer を組み立てる
// 全要素が欠けたら空文字を返し 呼び出し側が付与をスキップする
export function buildFooter(input: {
  transcriptPath: string | null
  ownerDir: string | null
  usage?: UsageSnapshot
  env?: NodeJS.ProcessEnv
}): string {
  const env = input.env ?? process.env
  const usage = input.usage ?? readCachedUsage()
  const entry = input.transcriptPath ? readLastAssistantEntry(input.transcriptPath) : null

  const data: J = {}
  if (entry) {
    const window = contextWindow(input.ownerDir)
    data.model = { display_name: modelDisplayName(entry.model) }
    // effort はモデル名と同じ行にしか出ないため モデルが取れないときは effort も出ない
    const effort = entry.effort ?? env.CLAUDE_EFFORT
    if (effort) data.effort = { level: effort }
    data.context_window = { used_percentage: Math.floor((entry.tokens / window) * 100) }
  }
  const rateLimits: J = {}
  if (usage.session) rateLimits.five_hour = usage.session
  if (usage.weekly) rateLimits.seven_day = usage.weekly
  if (Object.keys(rateLimits).length > 0) data.rate_limits = rateLimits

  return buildStatusBlock(data, input.ownerDir ? readBranch(input.ownerDir) : null, modelUsageSuffix(usage.modelScoped))
}
