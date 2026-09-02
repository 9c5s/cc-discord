import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { isHex32, isPid, isSessionId, resolveInDir } from './ids'
import { stateDir } from './routes'

// 現行 activation のポインタと heartbeat ---
// activation とは 1 回の SessionStart (startup / resume / clear / fork) で始まる期間である
// compaction は同じセッションの継続なので activation を変えない
// hook がポインタを書き proxy が heartbeat を書き watcher が両方を読んで自律終了を決める

// heartbeat の鮮度 (proxy は 5 秒ごとに書く)
export const HEARTBEAT_TTL_MS = 15_000
// 掃除の対象になる年齢 (ポインタ 7 日 heartbeat 1 時間)
export const POINTER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const HEARTBEAT_MAX_AGE_MS = 60 * 60 * 1000

export type ActivationSource = 'startup' | 'resume' | 'clear' | 'compact' | 'fork'
const SOURCES: ActivationSource[] = ['startup', 'resume', 'clear', 'compact', 'fork']

export type Pointer = {
  claude_pid: number
  run_id: string | null
  session_id: string
  activation_id: string
  transcript_path: string
  source: ActivationSource
  model?: string
  written_at: number
}

export type Heartbeat = { run_id: string; written_at: number }

export function sessionDir(): string {
  return join(stateDir(), 'session', 'by-pid')
}

// 鮮度判定 ---
// 未来の時刻 数値でない値 有限でない値はすべて失効として扱う
export function isFresh(writtenAt: unknown, ttlMs: number, now: number = Date.now()): boolean {
  if (typeof writtenAt !== 'number' || !Number.isFinite(writtenAt)) return false
  const age = now - writtenAt
  return age >= 0 && age <= ttlMs
}

// PID からポインタのパスを解決する
// 形式が不正な PID では null を返し 読み書きも削除も行わない
function pointerPath(claudePid: number): string | null {
  if (!Number.isInteger(claudePid) || !isPid(String(claudePid))) return null
  return resolveInDir(sessionDir(), `${claudePid}.json`)
}

// PID と run_id から heartbeat のパスを解決する
// パスに run_id を含めるため PID を再利用した別 run と同じファイルを操作しない
function heartbeatPath(claudePid: number, runId: string): string | null {
  if (!Number.isInteger(claudePid) || !isPid(String(claudePid))) return null
  if (!isHex32(runId)) return null
  return resolveInDir(sessionDir(), `${claudePid}.${runId}.heartbeat`)
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
  if (v.run_id !== null && !isHex32(v.run_id)) return null
  if (typeof v.transcript_path !== 'string' || !v.transcript_path) return null
  if (!SOURCES.includes(v.source as ActivationSource)) return null
  if (typeof v.written_at !== 'number' || !Number.isFinite(v.written_at)) return null
  const p: Pointer = {
    claude_pid: claudePid,
    run_id: v.run_id as string | null,
    session_id: v.session_id,
    activation_id: v.activation_id,
    transcript_path: v.transcript_path,
    source: v.source as ActivationSource,
    written_at: v.written_at,
  }
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

export function writeHeartbeat(claudePid: number, runId: string, now: number = Date.now()): boolean {
  const path = heartbeatPath(claudePid, runId)
  if (!path) return false
  return writeAtomic(path, JSON.stringify({ run_id: runId, written_at: now }))
}

// heartbeat を読む
// 内容の run_id が要求と違えば null を返す (PID 再利用した別 run の値を採用しない)
export function readHeartbeat(claudePid: number, runId: string): Heartbeat | null {
  const path = heartbeatPath(claudePid, runId)
  if (!path) return null
  let v: Record<string, unknown>
  try {
    v = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
  if (v.run_id !== runId) return null
  if (typeof v.written_at !== 'number' || !Number.isFinite(v.written_at)) return null
  return { run_id: runId, written_at: v.written_at }
}

// heartbeat を削除する (compare-and-delete)
// 内容の run_id が自分のものであることを確認してから消す
// 削除できなくても TTL で失効する
export function deleteHeartbeat(claudePid: number, runId: string): boolean {
  const path = heartbeatPath(claudePid, runId)
  if (!path) return false
  if (!readHeartbeat(claudePid, runId)) return false
  try {
    rmSync(path, { force: true })
    return true
  } catch {
    return false
  }
}

// heartbeat の状態を 4 つに分ける
// 掃除では missing と expired だけを削除の根拠にし error では保持する
// (権限や I/O や解析の失敗を生存の否定と取り違えないため)
export type HeartbeatState = { state: 'missing' | 'fresh' | 'expired' | 'error' }

export function inspectHeartbeat(claudePid: number, runId: string, now: number = Date.now()): HeartbeatState {
  const path = heartbeatPath(claudePid, runId)
  if (!path) return { state: 'error' }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    return { state: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'error' }
  }
  let v: Record<string, unknown>
  try {
    v = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { state: 'error' }
  }
  if (v.run_id !== runId) return { state: 'error' }
  if (typeof v.written_at !== 'number' || !Number.isFinite(v.written_at)) return { state: 'error' }
  return { state: isFresh(v.written_at, HEARTBEAT_TTL_MS, now) ? 'fresh' : 'expired' }
}

// 現行 activation を解決する ---
// run_id が一致するポインタだけを採用し PID の再利用や別起動の取り違えを防ぐ
// run_id を持たないプロセスは進捗転送の対象外なので常に null になる
export function currentActivation(claudePid: number, runId: string | null): Pointer | null {
  if (!runId) return null
  const p = readPointer(claudePid)
  if (!p || p.run_id !== runId) return null
  return p
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

// 古いポインタと heartbeat の掃除 ---
// プロセスの照会はしない (PID の再利用や照会失敗の扱いを持ち込まない)
// ポインタは 自分の PID 以外で 7 日より古く heartbeat が不在または失効と確認できたものだけを消す
// heartbeat は 1 時間より古いものを消す
export function sweepStale(selfPid: number, now: number = Date.now()): { removed: string[]; kept: string[] } {
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
    const hb = /^(\d{1,10})\.([0-9a-f]{32})\.heartbeat$/.exec(name)
    if (hb) {
      const beat = readHeartbeat(Number(hb[1]), hb[2])
      if (beat && now - beat.written_at > HEARTBEAT_MAX_AGE_MS) record(name, removeFile(name))
      else kept.push(name)
      continue
    }

    const pt = /^(\d{1,10})\.json$/.exec(name)
    if (!pt) continue
    const pid = Number(pt[1])
    if (pid === selfPid) {
      kept.push(name)
      continue
    }
    const p = readPointer(pid)
    if (!p || now - p.written_at <= POINTER_MAX_AGE_MS) {
      kept.push(name)
      continue
    }
    const state = p.run_id ? inspectHeartbeat(pid, p.run_id, now).state : 'missing'
    if (state === 'missing' || state === 'expired') record(name, removeFile(name))
    else kept.push(name)
  }

  return { removed, kept }
}
