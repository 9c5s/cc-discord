import type { ChannelEntity } from './routing'

// discord.js のチャンネルのうち担当の判定に使う部分 (type は ChannelType の数値)
export type ChannelLike = { id: string; type: number; parentId?: string | null; recipientId?: string | null }

// 担当の決定関数が受け取る REST の形へ変換する
export function toEntity(ch: ChannelLike): ChannelEntity {
  return {
    id: ch.id,
    type: ch.type,
    parent_id: ch.parentId ?? null,
    ...(ch.recipientId ? { recipients: [{ id: ch.recipientId }] } : {}),
  }
}
