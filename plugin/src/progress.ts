import type { Pointer } from './activation'
import { createTailReader, extractMessages, packMessages, type TailReader } from './watch'

// 進捗の転送 ---
// 現行 activation の transcript の増分を要約し メモリ上の宛先へ投稿する

// 宛先の有効期間
export const TARGET_TTL_MS = 12 * 60 * 60 * 1000
// 429 の待ちに付き合う上限
export const MAX_RETRY_WAIT_MS = 10_000
// 1 チャンクあたりの送信の回数 (429 で 1 度だけ待って送り直す)
const MAX_SEND_ATTEMPTS = 2
// Discord の上限に対する最終安全弁 (コードポイント単位で数える)
const MAX_CONTENT_POINTS = 1900

export type ProgressTarget = {
  id: string
  parentId: string
  kind: 'guild' | 'dm'
  activationId: string
  setAt: number
  recipientId?: string
}

export type SendResult = { ok: true } | { ok: false; retryAfterMs?: number }

export type ProgressForwarder = {
  setTarget(t: ProgressTarget): void
  currentTargetId(): string | null
  tick(): void
  poll(): Promise<void>
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function clip(text: string): string {
  const points = [...text]
  return points.length > MAX_CONTENT_POINTS ? points.slice(0, MAX_CONTENT_POINTS).join('') : text
}

export function createProgressForwarder(deps: {
  activation: () => Pointer | null
  canSend: (t: ProgressTarget) => boolean
  send: (targetId: string, text: string) => Promise<SendResult>
  openReader?: (path: string) => TailReader
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  log?: (m: string) => void
}): ProgressForwarder {
  const openReader = deps.openReader ?? createTailReader
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((): void => {})

  // 追っている activation のポインタ
  let followed: Pointer | null = null
  let reader: TailReader | null = null
  let target: ProgressTarget | null = null
  let polling = false

  const isLive = (t: ProgressTarget): boolean => now() - t.setAt <= TARGET_TTL_MS

  const open = (path: string): TailReader | null => {
    try {
      return openReader(path)
    } catch (e) {
      log(`[progress] failed to open the transcript: ${e}`)
      return null
    }
  }

  const tick = (): void => {
    const p = deps.activation()
    const activationChanged = p?.activation_id !== followed?.activation_id
    if (activationChanged) target = null
    // 開けなかった reader は次の tick で開き直す
    if (activationChanged || p?.transcript_path !== followed?.transcript_path || !reader) {
      reader = p ? open(p.transcript_path) : null
    }
    followed = p
  }

  // 読み取りを始めた時点の宛先と activation が今も現行で 送信できるかを確かめる
  const holds = (t: ProgressTarget): boolean => {
    tick()
    if (target !== t || followed?.activation_id !== t.activationId || !isLive(t)) return false
    if (deps.canSend(t)) return true
    log(`[progress] skip: cannot send to ${t.id}`)
    return false
  }

  // false を返したら残りのチャンクを捨てる
  const deliver = async (t: ProgressTarget, text: string): Promise<boolean> => {
    for (let attempt = 1; ; attempt++) {
      if (!holds(t)) return false
      let res: SendResult
      try {
        res = await deps.send(t.id, text)
      } catch (e) {
        log(`[progress] failed to send to ${t.id}: ${e}`)
        return true
      }
      if (res.ok) return true
      if (res.retryAfterMs === undefined) {
        log(`[progress] failed to send to ${t.id}`)
        return true
      }
      if (res.retryAfterMs > MAX_RETRY_WAIT_MS || attempt >= MAX_SEND_ATTEMPTS) {
        log(`[progress] skip: rate limited for ${res.retryAfterMs}ms`)
        return true
      }
      await sleep(res.retryAfterMs)
    }
  }

  const forward = async (): Promise<void> => {
    const t = target
    let lines: string[]
    try {
      lines = reader?.readNewLines() ?? []
    } catch (e) {
      log(`[progress] failed to read the transcript: ${e}`)
      return
    }
    // 宛先が無い間に読んだ行は送らずに捨てる
    if (!t || !isLive(t)) return
    for (const chunk of packMessages(lines.flatMap((line) => extractMessages(line)))) {
      if (!(await deliver(t, clip(chunk)))) return
    }
  }

  return {
    setTarget(t: ProgressTarget): void {
      tick()
      if (t.activationId !== followed?.activation_id) {
        log('[progress] ignored a target for another activation')
        return
      }
      // 差し替えを参照の比較で検出するため 設定のたびに新しいオブジェクトにする
      target = { ...t }
    },

    currentTargetId: () => (target && isLive(target) ? target.id : null),

    tick,

    async poll(): Promise<void> {
      if (polling) return
      polling = true
      try {
        await forward()
      } finally {
        polling = false
      }
    },
  }
}
