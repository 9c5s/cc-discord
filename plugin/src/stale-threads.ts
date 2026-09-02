import type { DiscordClient } from './discord-api'
import { isSnowflake } from './ids'
import { deleteProgressBody, deleteTarget, listTargets, readProgressBody } from './progress-target'

// 滞留した進捗スレッドの archive ---
// 進捗スレッドは自動 archive を 60 分にして作るが 投稿が続く限り開いたままになる
// 12 時間動きの無いものを閉じ notify が archived スレッドへ投稿して開き直すのを防ぐ

// Discord snowflake の基準時刻
const DISCORD_EPOCH = 1_420_070_400_000
// 動きが無いとみなすまでの時間 (宛先の有効期間と同じ閾値)
const STALE_MS = 12 * 60 * 60 * 1000
// 進捗スレッドの名前 (summarize.threadName が付ける先頭の日時)
const THREAD_NAME_RE = /^\[\d{2}\/\d{2} \d{2}:\d{2}\]/

type Thread = Record<string, unknown>

// snowflake から生成時刻を復元する
export function snowflakeTime(id: unknown): number | null {
  if (!isSnowflake(id)) return null
  return Number(BigInt(id) >> 22n) + DISCORD_EPOCH
}

// スレッドの最終活動時刻を求める
// 最終メッセージ 作成時刻 スレッド id の順に見る
function lastActivity(thread: Thread): number | null {
  const fromMessage = snowflakeTime(thread.last_message_id)
  if (fromMessage !== null) return fromMessage
  const meta = thread.thread_metadata as Record<string, unknown> | undefined
  if (typeof meta?.create_timestamp === 'string') {
    const t = Date.parse(meta.create_timestamp)
    if (Number.isFinite(t)) return t
  }
  return snowflakeTime(thread.id)
}

// archive の対象かを判定する
// 担当チャンネル直下 bot が作成 名前の規約 自動 archive 60 分 12 時間の無活動 をすべて満たすものだけを閉じる
export function isStaleThread(
  thread: Thread,
  opts: { parentId: string; botId: string; now: number },
): boolean {
  if (thread.parent_id !== opts.parentId) return false
  if (thread.owner_id !== opts.botId) return false
  if (typeof thread.name !== 'string' || !THREAD_NAME_RE.test(thread.name)) return false
  const meta = thread.thread_metadata as Record<string, unknown> | undefined
  if (meta?.auto_archive_duration !== 60) return false
  const last = lastActivity(thread)
  if (last === null) return false
  return opts.now - last >= STALE_MS
}

// 滞留スレッドを閉じ その宛先を取り除く
// 宛先 (.meta) は id が一致するものだけ 本体は内容が一致するときだけ消す
// 片方の一致を理由に他方を消さない (本体と .meta が別スレッドを指しうるため)
export async function archiveStaleThreads(
  api: DiscordClient,
  args: { owner: string; guildId: string; ownerChannelId: string; botId: string; now?: number },
): Promise<string[]> {
  const now = args.now ?? Date.now()
  const res = await api.getActiveThreads(args.guildId)
  if (!res.ok) return []

  const archived: string[] = []
  for (const thread of res.value as Thread[]) {
    if (!isStaleThread(thread, { parentId: args.ownerChannelId, botId: args.botId, now })) continue
    const id = thread.id
    if (!isSnowflake(id)) continue

    // 閉じる前に この スレッドを指す宛先だけを取り除く
    for (const entry of listTargets(args.owner)) {
      if (entry.target.id === id) deleteTarget(args.owner, entry.activationId)
    }
    if (readProgressBody(args.owner) === id) deleteProgressBody(args.owner)

    const done = await api.archiveThread(id)
    if (done.ok) archived.push(id)
  }
  return archived
}
