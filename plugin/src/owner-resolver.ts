import type { Access } from './access'
import type { DiscordClient } from './discord-api'
import {
  TARGET_TTL_MS,
  deleteProgressBody,
  deleteTarget,
  listTargets,
} from './progress-target'
import { deleteRoute, writeRoute } from './routes'
import { resolveOwnerChannel, type GuildChannels } from './routing'

// 担当チャンネルの解決 ---
// 60 秒ごとに access.json と guild のチャンネル一覧から担当を決め直す
// 判定は決定関数 1 つに集約し 候補が複数なら fail closed にする
// route ファイルの更新と削除は成功するまで再試行するが 安全性はそれに依存しない
// (進捗送信も inbound も 実体を見る gate と メモリ上の担当で止まる)

// 解決に成功しないまま担当を保ち続ける上限
// REST の一時障害では据え置き 障害が続く間は担当を手放して配送も進捗も止める (fail closed)
const RESOLVE_GRACE_MS = 5 * 60_000

export type OwnerResolver = {
  channelId(): string | null
  guildId(): string | null
  resolve(): Promise<void>
}

export function createOwnerResolver(deps: {
  api: DiscordClient
  access: () => Access
  owner: string
  now?: () => number
  log?: (msg: string) => void
}): OwnerResolver {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((): void => {})

  let channelId: string | null = null
  let guildId: string | null = null
  // 最後に担当を解決しきれた時刻 (取得失敗が続いたときの打ち切りに使う)
  let lastSuccessAt: number | null = null
  // ファイルへの反映が失敗した周期を覚え 担当が変わらなくても次の周期で書き直す
  let unapplied = false
  let running = false

  // route の更新と 担当に紐づく宛先の削除
  // 宛先は guild のものだけを消す (DM は guild の担当に依存しない)
  // 失敗した周期は未反映として記録し 次の周期で再試行する
  const applyFiles = (next: string | null, dropTargets: boolean): void => {
    let ok = true
    if (next === null) {
      ok = deleteRoute(deps.owner) && ok
    } else {
      try {
        writeRoute(deps.owner, next)
      } catch (e) {
        log(`[resolver] failed to write the route: ${e}`)
        ok = false
      }
    }
    if (dropTargets) {
      ok = deleteProgressBody(deps.owner) && ok
      for (const entry of listTargets(deps.owner)) {
        if (entry.target.kind !== 'guild') continue
        ok = deleteTarget(deps.owner, entry.activationId) && ok
      }
    }
    unapplied = !ok
  }

  // 期限切れの宛先を掃除する
  const sweepExpired = (): void => {
    for (const entry of listTargets(deps.owner)) {
      if (now() - entry.target.written_at > TARGET_TTL_MS) deleteTarget(deps.owner, entry.activationId)
    }
  }

  const setOwned = (next: string | null, nextGuild: string | null): void => {
    const previous = channelId
    channelId = next
    guildId = nextGuild

    // 担当を持たない間は route も担当に紐づく宛先も残さない (毎周期 冪等に消す)
    if (next === null) {
      applyFiles(null, true)
      return
    }
    if (previous === next && !unapplied) return
    // 宛先を消すのは担当が別チャンネルへ移ったときだけである
    // 起動直後の確定で消すと 同じ担当で並走する他セッションの宛先まで巻き込む
    applyFiles(next, previous !== null && previous !== next)
  }

  // 取得に失敗した周期の後始末
  // 猶予の内は前回の担当を据え置き 超えたら手放す
  // 担当を持たない周期でも 前回のファイル反映が済んでいなければ試し直す
  const giveUpIfStale = (): void => {
    if (channelId === null) {
      if (unapplied) setOwned(null, null)
      return
    }
    if (lastSuccessAt !== null && now() - lastSuccessAt <= RESOLVE_GRACE_MS) return
    log('[resolver] dropping the owner channel: the resolution keeps failing')
    setOwned(null, null)
  }

  const resolve = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      const access = deps.access()

      // access から外れた担当は REST の結果を待たずに無効化する
      if (channelId !== null && !Object.prototype.hasOwnProperty.call(access.groups, channelId)) {
        log(`[resolver] the owner channel left access.groups: ${channelId}`)
        setOwned(null, null)
      }

      const guilds = await deps.api.getGuilds()
      if (!guilds.ok) {
        log(`[resolver] failed to list guilds: ${guilds.error}`)
        giveUpIfStale()
        return
      }
      const entries: GuildChannels[] = []
      for (const g of guilds.value) {
        const channels = await deps.api.getGuildChannels(g.id)
        if (!channels.ok) {
          log(`[resolver] failed to list channels of ${g.id}: ${channels.error}`)
          giveUpIfStale()
          return
        }
        entries.push({ guildId: g.id, channels: channels.value })
      }

      lastSuccessAt = now()
      const resolution = resolveOwnerChannel(entries, access.groups, deps.owner)
      if (resolution.kind === 'resolved') {
        setOwned(resolution.channelId, resolution.guildId)
      } else {
        if (resolution.kind === 'ambiguous') {
          log(`[resolver] ambiguous owner channels: ${resolution.channelIds.join(', ')}`)
        }
        setOwned(null, null)
      }

      sweepExpired()
    } finally {
      running = false
    }
  }

  return {
    channelId: () => channelId,
    guildId: () => guildId,
    resolve,
  }
}
