import { snowflakeTime } from './ids'

// 滞留した進捗スレッドの archive ---
// 進捗スレッドは自動 archive を 60 分にして作るが 投稿が続く限り開いたままになる
// 13 時間動きの無いものを閉じ 進捗の投稿が archived スレッドを開き直すのを防ぐ

// 動きが無いとみなすまでの時間 (宛先の有効期間 12 時間より 1 時間長い)
export const STALE_MS = 13 * 60 * 60 * 1000
// 進捗スレッドの名前 (summarize.threadName が付ける先頭の日時)
const THREAD_NAME_RE = /^\[\d{2}\/\d{2} \d{2}:\d{2}\]/

export type ThreadView = {
  id: string
  parentId: string | null
  ownerId: string | null
  name: string
  autoArchiveDuration: number | null
  lastMessageId: string | null
  createdTimestamp: number | null
}

// スレッドの最終活動時刻を求める
// 最終メッセージ 作成時刻 スレッド id の順に見る
function lastActivity(t: ThreadView): number | null {
  const fromMessage = snowflakeTime(t.lastMessageId)
  if (fromMessage !== null) return fromMessage
  if (typeof t.createdTimestamp === 'number' && Number.isFinite(t.createdTimestamp)) return t.createdTimestamp
  return snowflakeTime(t.id)
}

// archive の対象かを判定する
// 担当チャンネル直下 bot が作成 名前の規約 自動 archive 60 分 13 時間の無活動 現在の宛先でない をすべて満たすものだけを閉じる
export function isStaleThread(
  t: ThreadView,
  opts: { parentId: string; botId: string; currentTargetId: string | null; now: number },
): boolean {
  if (t.parentId !== opts.parentId) return false
  if (t.ownerId !== opts.botId) return false
  if (!THREAD_NAME_RE.test(t.name)) return false
  if (t.autoArchiveDuration !== 60) return false
  if (t.id === opts.currentTargetId) return false
  const last = lastActivity(t)
  if (last === null) return false
  return opts.now - last >= STALE_MS
}

// 滞留スレッドを閉じ 閉じられたものの id を返す
export async function archiveStaleThreads(
  ops: { listActiveThreads(): Promise<ThreadView[]>; archive(id: string): Promise<boolean> },
  opts: { parentId: string; botId: string; currentTargetId: string | null; now?: number },
): Promise<string[]> {
  const now = opts.now ?? Date.now()
  const archived: string[] = []
  for (const t of await ops.listActiveThreads()) {
    if (!isStaleThread(t, { ...opts, now })) continue
    if (await ops.archive(t.id)) archived.push(t.id)
  }
  return archived
}
