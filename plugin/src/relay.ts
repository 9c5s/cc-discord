import { StringDecoder } from 'string_decoder'

// stdio の JSON-RPC 中継 ---
// MCP stdio トランスポートは改行区切りの JSON-RPC なので 行単位で読めば中継できる
// 読み取りは受信順に直列化し 書き込みは方向ごとに単一の FIFO writer を通す

export type Json = Record<string, unknown>

export type ReadOptions = {
  // 1 行 1 メッセージとして呼ばれる
  // Promise を返すと その完了まで次の行を渡さない (server -> client の直列化に使う)
  onMessage: (msg: Json, raw: string) => Promise<void> | void
  // JSON として解析できない行 (診断してから捨てる)
  onInvalid?: (line: string) => void
  // 全ての行の処理を終えた後の EOF 通知
  onEnd?: () => void
}

// 行単位で読み JSON オブジェクトとして handler に渡す
// UTF-8 のチャンク境界は StringDecoder で吸収し EOF では未終端の最終行も処理する
export function readJsonLines(src: NodeJS.ReadableStream, opts: ReadOptions): void {
  const decoder = new StringDecoder('utf8')
  const queue: string[] = []
  let buf = ''
  let running = false
  let ended = false

  const pump = async (): Promise<void> => {
    if (running) return
    running = true
    while (queue.length > 0) {
      const line = queue.shift() as string
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        opts.onInvalid?.(line)
        continue
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        opts.onInvalid?.(line)
        continue
      }
      await opts.onMessage(parsed as Json, line)
    }
    running = false
    if (ended) opts.onEnd?.()
  }

  const enqueue = (line: string): void => {
    if (line.trim()) queue.push(line)
  }

  src.on('data', (chunk: Buffer) => {
    buf += decoder.write(chunk)
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      enqueue(buf.slice(0, i))
      buf = buf.slice(i + 1)
    }
    void pump()
  })

  src.on('end', () => {
    buf += decoder.end()
    enqueue(buf)
    buf = ''
    ended = true
    void pump()
  })
}

export type Writer = {
  write(line: string): void
  readonly broken: boolean
}

// 単一の FIFO writer
// write() が false を返したら drain を待ってから次を書く
// 書けなくなったら待機中のメッセージを破棄する (未処理の要求を保持したまま継続しない)
export function createWriter(dst: NodeJS.WritableStream, onBroken?: () => void): Writer {
  const queue: string[] = []
  let waiting = false
  let broken = false

  const breakDown = (): void => {
    if (broken) return
    broken = true
    queue.length = 0
    onBroken?.()
  }

  dst.on('error', breakDown)

  const flush = (): void => {
    if (waiting || broken) return
    while (queue.length > 0) {
      const line = queue.shift() as string
      let ok: boolean
      try {
        ok = dst.write(line)
      } catch {
        breakDown()
        return
      }
      if (!ok) {
        waiting = true
        dst.once('drain', () => {
          waiting = false
          flush()
        })
        return
      }
    }
  }

  return {
    write(line: string): void {
      if (broken) return
      queue.push(`${line}\n`)
      flush()
    },
    get broken(): boolean {
      return broken
    },
  }
}
