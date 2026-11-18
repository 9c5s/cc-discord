import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { isHex32, isPid, isSessionId, resolveInDir } from './ids'
import { lookupProcess, type ProcessLookup } from './process-tree'
import { stateDir } from './state-dir'

// 現行 activation のポインタ ---
// activation とは 1 回の SessionStart (startup / resume / clear / fork) で始まる期間である
// compaction は同じセッションの継続なので activation を変えない
// hook がポインタを書き server が読む

export type ActivationSource = 'startup' | 'resume' | 'clear' | 'compact' | 'fork'
const SOURCES: ActivationSource[] = ['startup', 'resume', 'clear', 'compact', 'fork']

export type Pointer = {
  claude_pid: number
  // Claude Code のプロセスの作成時刻 (epoch ミリ秒)
  claude_started_at?: number
  session_id: string
  activation_id: string
  transcript_path: string
  source: ActivationSource
  model?: string
  written_at: number
}

export function sessionDir(): string {
  return join(stateDir(), 'session', 'by-pid')
}

// PID からポインタのパスを解決する
// 形式が不正な PID では null を返し 読み書きも削除も行わない
function pointerPath(claudePid: number): string | null {
  if (!Number.isInteger(claudePid) || !isPid(String(claudePid))) return null
  return resolveInDir(sessionDir(), `${claudePid}.json`)
}

// 一時ファイルへ書いてから rename する
// 途中状態を reader に見せないため 書き込みはすべてこの経路を通す
function writeAtomic(path: string, content: string): boolean {
  try {
    mkdirSync(sessionDir(), { recursive: true, mode: 0o700 })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}

// ポインタの構文検証
// ファイル名の PID と内容の PID の一致まで確認する
// run_id があっても取り込まない
function parsePointer(raw: string, claudePid: number): Pointer | null {
  let v: Record<string, unknown>
  try {
    v = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
  if (v.claude_pid !== claudePid) return null
  if (!isSessionId(v.session_id)) return null
  if (!isHex32(v.activation_id)) return null
  if (typeof v.transcript_path !== 'string' || !v.transcript_path) return null
  if (!SOURCES.includes(v.source as ActivationSource)) return null
  if (typeof v.written_at !== 'number' || !Number.isFinite(v.written_at)) return null
  const hasStartedAt = 'claude_started_at' in v
  if (hasStartedAt && (typeof v.claude_started_at !== 'number' || !Number.isFinite(v.claude_started_at))) return null
  const p: Pointer = {
    claude_pid: claudePid,
    session_id: v.session_id,
    activation_id: v.activation_id,
    transcript_path: v.transcript_path,
    source: v.source as ActivationSource,
    written_at: v.written_at,
  }
  if (hasStartedAt) p.claude_started_at = v.claude_started_at as number
  if (typeof v.model === 'string') p.model = v.model
  return p
}

export function readPointer(claudePid: number): Pointer | null {
  const path = pointerPath(claudePid)
  if (!path) return null
  try {
    return parsePointer(readFileSync(path, 'utf8'), claudePid)
  } catch {
    return null
  }
}

export function writePointer(p: Pointer): boolean {
  const path = pointerPath(p.claude_pid)
  if (!path) return false
  return writeAtomic(path, JSON.stringify(p))
}

// ポインタを削除する
// 不在は削除済みとみなして成功として扱う
export function deletePointer(claudePid: number): boolean {
  const path = pointerPath(claudePid)
  if (!path) return false
  try {
    rmSync(path, { force: true })
    return true
  } catch {
    return false
  }
}

function removeFile(name: string): boolean {
  const path = resolveInDir(sessionDir(), name)
  if (!path) return false
  try {
    rmSync(path, { force: true })
    return true
  } catch {
    return false
  }
}

// ポインタを書いたプロセスが終了したか PID が再利用されたかを判定する
// claude_started_at を持たないポインタは 書かれた後に起動したプロセスを PID の再利用とみなす
function isAbandoned(pid: number, lookup: (pid: number) => ProcessLookup): boolean {
  const r = lookup(pid)
  if (r.kind === 'missing') return true
  if (r.kind === 'error') return false
  const p = readPointer(pid)
  if (!p) return false
  if (p.claude_started_at !== undefined) return r.info.startMs !== p.claude_started_at
  return r.info.startMs > p.written_at
}

// 古いポインタと heartbeat の掃除 ---
// ポインタは 自分の PID 以外で プロセスが存在しないか PID が再利用されたと判定できたものだけを消す
// 照会に失敗したものは プロセスが無いと判定できないため残す
// heartbeat はもう読まないので すべて消す
export function sweepStale(
  selfPid: number,
  lookup: (pid: number) => ProcessLookup = lookupProcess,
): { removed: string[]; kept: string[] } {
  let names: string[]
  try {
    names = readdirSync(sessionDir())
  } catch {
    return { removed: [], kept: [] }
  }

  const removed: string[] = []
  const kept: string[] = []
  const record = (name: string, ok: boolean): void => {
    if (ok) removed.push(name)
    else kept.push(name)
  }

  for (const name of names) {
    if (/^\d{1,10}\.[0-9a-f]{32}\.heartbeat$/.test(name)) {
      record(name, removeFile(name))
      continue
    }

    const pt = /^(\d{1,10})\.json$/.exec(name)
    if (!pt) continue
    const pid = Number(pt[1])
    if (pid !== selfPid && isAbandoned(pid, lookup)) record(name, removeFile(name))
    else kept.push(name)
  }

  return { removed, kept }
}
