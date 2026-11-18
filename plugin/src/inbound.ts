import { closeSync, mkdirSync, openSync, readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { isOwnerName, isSnowflake, resolveInDir } from './ids'
import { stateDir } from './state-dir'
import { threadName } from './summarize'

// inbound の排他と typing と進捗スレッド ---
// ロックは同じ担当の複数プロセスが同じ inbound を二重に処理しないための安全境界である
// typing はロックを取ったプロセスだけが継続し reply で無条件に停止する

// 残置ロックの回収までの時間
// 通知は前の処理が終わるまで直列のキューで待つため 処理の開始が数十秒遅れることがある
// 処理中のロックを回収すると同じ inbound を二重に処理できてしまうので
// 回収は異常終了で残ったロックの掃除だけを狙い 宛先の有効期間と同じ長さにする
const LOCK_MAX_AGE_MS = 12 * 60 * 60 * 1000
// Discord の typing 表示は約 10 秒で消えるため 8 秒ごとに送り直す
const TYPING_RESEND_MS = 8_000
// 応答が返らないまま typing が残り続けないための安全弁
const TYPING_MAX_MS = 10 * 60_000

export function progressDir(): string {
  return join(stateDir(), 'progress-thread')
}

function lockPath(owner: string, messageId: string): string | null {
  if (!isOwnerName(owner) || !isSnowflake(messageId)) return null
  return resolveInDir(progressDir(), `${owner}.lock-${messageId}`)
}

// inbound の処理権を wx で 1 プロセスに絞る
// EEXIST も それ以外の失敗も取得できなかったものとして扱う (fail closed)
export function acquireInboundLock(owner: string, messageId: string): boolean {
  const path = lockPath(owner, messageId)
  if (!path) return false
  try {
    mkdirSync(progressDir(), { recursive: true, mode: 0o700 })
    closeSync(openSync(path, 'wx', 0o600))
    return true
  } catch {
    return false
  }
}

// 同じ担当の古いロックを回収する
export function sweepInboundLocks(owner: string, now: number = Date.now()): number {
  if (!isOwnerName(owner)) return 0
  let names: string[]
  try {
    names = readdirSync(progressDir())
  } catch {
    return 0
  }
  const prefix = `${owner}.lock-`
  let removed = 0
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const path = resolveInDir(progressDir(), name)
    if (!path) continue
    try {
      if (now - statSync(path).mtimeMs <= LOCK_MAX_AGE_MS) continue
      rmSync(path, { force: true })
      removed++
    } catch {
      // 消せないロックは次の周期に委ねる
    }
  }
  return removed
}

// typing の継続 ---

export type Timers = {
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export const nodeTimers: Timers = {
  setInterval: (fn, ms) => {
    const h = setInterval(fn, ms)
    h.unref?.()
    return h
  },
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms)
    h.unref?.()
    return h
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export type TypingController = {
  start(chatId: string): void
  stop(chatId: string): void
  stopAll(): void
}

export function createTypingController(
  sendTyping: (chatId: string) => Promise<void>,
  opts: { timers?: Timers; onError?: (message: string) => void } = {},
): TypingController {
  const timers = opts.timers ?? nodeTimers
  const active = new Map<string, { interval: unknown; guard: unknown }>()

  const send = (chatId: string): void => {
    sendTyping(chatId).catch((e: unknown) => opts.onError?.(`typing failed chat=${chatId}: ${e}`))
  }

  const stop = (chatId: string): void => {
    const s = active.get(chatId)
    if (!s) return
    timers.clearInterval(s.interval)
    timers.clearTimeout(s.guard)
    active.delete(chatId)
  }

  return {
    start(chatId: string): void {
      if (active.has(chatId)) return
      send(chatId)
      const interval = timers.setInterval(() => send(chatId), TYPING_RESEND_MS)
      const guard = timers.setTimeout(() => stop(chatId), TYPING_MAX_MS)
      active.set(chatId, { interval, guard })
    },
    stop,
    stopAll(): void {
      for (const chatId of [...active.keys()]) stop(chatId)
    },
  }
}

// 進捗スレッドの作成 ---

export type TargetLocation = { id: string; parent: string; kind: 'guild' | 'dm' }

// スレッドの作成に使う Discord の操作 (失敗は null で返す)
export type ThreadOps = {
  // アンカーを投稿してそのメッセージ id を返す
  postAnchor(chatId: string): Promise<string | null>
  // アンカーから public スレッドを立ててその id を返す
  startThread(chatId: string, anchorId: string, name: string): Promise<string | null>
}

// inbound の宛先を決める
// DM とスレッド内の inbound はその場を宛先にし GuildText ではアンカーを投稿してスレッドを作る
// アンカーやスレッドの作成に失敗したら親チャンネルへ退避する (進捗の喪失より配送を優先する)
export async function createProgressTarget(
  ops: ThreadOps,
  input: { chatId: string; kind: 'guild' | 'dm'; parentId: string; content: string; ts: Date },
): Promise<TargetLocation> {
  const { chatId, kind, parentId } = input
  if (kind === 'dm') return { id: chatId, parent: chatId, kind: 'dm' }
  if (chatId !== parentId) return { id: chatId, parent: parentId, kind: 'guild' }

  const anchorId = await ops.postAnchor(chatId)
  if (anchorId === null) return { id: chatId, parent: chatId, kind: 'guild' }

  const threadId = await ops.startThread(chatId, anchorId, threadName(input.content, input.ts))
  if (threadId === null) return { id: chatId, parent: chatId, kind: 'guild' }
  return { id: threadId, parent: chatId, kind: 'guild' }
}
