#!/usr/bin/env bun
import { randomBytes } from 'crypto'
import {
  deletePointer,
  readPointer,
  sweepStale,
  writePointer,
  type ActivationSource,
  type Pointer,
} from './activation'
import { isPid, isSessionId } from './ids'
import { debugLog } from './notify'
import { lookupProcess } from './process-tree'

// SessionStart hook ---
// 1 回の SessionStart で始まる期間を activation と呼び このプロセスの現行 activation をポインタに書く
// compaction は同じ作業の継続なので activation を変えず 進捗の宛先を切らない
// 失敗したときは漏洩より欠落になる順序を選ぶ (旧ポインタを削除してから新ポインタを書く)

const SOURCES: ActivationSource[] = ['startup', 'resume', 'clear', 'compact', 'fork']

export type StartInput = {
  claudePid: number
  sessionId: string
  transcriptPath: string
  source: ActivationSource
  model?: string
}

// hook の stdin と環境変数から入力を組み立てる
// 形式が不正なら null を返し 何もせず終了する
export function parseSessionStart(raw: string, env: NodeJS.ProcessEnv): StartInput | null {
  const pid = env.CLAUDE_PID
  if (!isPid(pid)) return null

  let v: Record<string, unknown>
  try {
    v = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
  if (!isSessionId(v.session_id)) return null
  if (typeof v.transcript_path !== 'string' || !v.transcript_path) return null
  if (!SOURCES.includes(v.source as ActivationSource)) return null

  const input: StartInput = {
    claudePid: Number(pid),
    sessionId: v.session_id,
    transcriptPath: v.transcript_path,
    source: v.source as ActivationSource,
  }
  if (typeof v.model === 'string') input.model = v.model
  return input
}

// 新しいポインタの内容と activation を新規に起こすかを決める
// compact で session_id が一致するときだけ activation_id を維持する
export function planActivation(input: {
  existing: Pointer | null
  claudePid: number
  claudeStartedAt: number | null
  sessionId: string
  transcriptPath: string
  source: ActivationSource
  model?: string
  now: number
  newActivationId: () => string
}): { pointer: Pointer; isNew: boolean } {
  const { existing } = input
  const keep = input.source === 'compact' && existing !== null && existing.session_id === input.sessionId

  const pointer: Pointer = {
    claude_pid: input.claudePid,
    session_id: input.sessionId,
    activation_id: keep ? (existing as Pointer).activation_id : input.newActivationId(),
    transcript_path: input.transcriptPath,
    source: input.source,
    written_at: input.now,
  }
  if (input.claudeStartedAt !== null) pointer.claude_started_at = input.claudeStartedAt
  if (input.model !== undefined) pointer.model = input.model
  return { pointer, isNew: !keep }
}

export type StartDeps = {
  sweep: () => void
  // Claude Code のプロセスの作成時刻 (epoch ミリ秒) を返す 取得できなければ null
  startedAt: (pid: number) => number | null
  newActivationId?: () => string
  now?: () => number
  log?: (msg: string) => void
}

// ポインタを置き換えてから古いポインタを掃除する
// 新しい activation では 旧ポインタを削除してから書き 削除の結果に関わらず置換を試みる
// 削除できて書き込めなかった場合は旧 activation が非現行になり 新 activation の進捗が欠落する
// 両方失敗した場合だけ旧ポインタが残る (受容リスク)
export function runSessionStart(input: StartInput, deps: StartDeps): void {
  const now = deps.now ?? Date.now
  const newActivationId = deps.newActivationId ?? (() => randomBytes(16).toString('hex'))
  const log = deps.log ?? debugLog

  const existing = readPointer(input.claudePid)
  const claudeStartedAt = deps.startedAt(input.claudePid)
  const plan = planActivation({ ...input, claudeStartedAt, existing, now: now(), newActivationId })

  if (plan.isNew && existing !== null && !deletePointer(input.claudePid)) {
    log('[session-start] failed to delete the previous pointer')
  }
  if (!writePointer(plan.pointer)) log('[session-start] failed to write the pointer')

  // 掃除はポインタの置き換えの後に行う (自分の PID のポインタは対象にしない)
  deps.sweep()
}

function startedAt(pid: number): number | null {
  const r = lookupProcess(pid)
  return r.kind === 'found' ? r.info.startMs : null
}

if (import.meta.main) {
  const raw = await new Response(Bun.stdin.stream()).text()
  const input = parseSessionStart(raw, process.env)
  if (input) {
    runSessionStart(input, {
      sweep: () => sweepStale(input.claudePid),
      startedAt,
    })
  }
}
