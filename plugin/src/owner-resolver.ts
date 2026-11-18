import type { Access } from './access'
import type { DiscordClient } from './discord-api'
import { TARGET_TTL_MS, deleteTarget, listTargets } from './progress-target'
import { resolveOwnerChannel, type GuildChannels } from './routing'

// 担当チャンネルの解決 ---
// 60 秒ごとに access.json と guild のチャンネル一覧から担当を決め直す
// 判定は決定関数 1 つに集約し 候補が複数なら fail closed にする
// 担当に紐づく宛先の削除は成功するまで再試行するが 安全性はそれに依存しない
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
  runId: string | null
  now?: () => number
  log?: (msg: string) => void
}): OwnerResolver {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((): void => {})

  let channelId: string | null = null
  let guildId: string | null = null
  // 最後に担当を解決しきれた時刻 (取得失敗が続いたときの打ち切りに使う)
  let lastSuccessAt: number | null = null
  // 宛先の削除に失敗した周期を覚え 担当が変わらなくても次の周期で消し直す
  let unapplied = false
  let running = false

  // 担当チャンネル以外を指す 自分の run の guild 宛先を消す
  // DM は guild の担当に依存しないため残す
  // 並走する他セッションの宛先まで消すと そのセッションの進捗が次の inbound まで止まる
  // 他セッションも同じ REST の結果から同じ判断に至るため こちらから触る必要は無い
  // 担当チャンネルを指す宛先は使用中のものなので残す (MCP だけの再起動の後や 削除を再試行する周期にも現れる)
  // 失敗した周期は未反映として記録し 次の周期で再試行する
  const releaseTargets = (current: string | null): void => {
    let ok = true
    for (const entry of listTargets(deps.owner)) {
      if (entry.target.kind !== 'guild') continue
      if (entry.target.run_id !== deps.runId) continue
      if (entry.target.parent === current) continue
      ok = deleteTarget(deps.owner, entry.activationId) && ok
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

    // 担当を持たない間は毎周期 冪等に消す
    // 担当を持つ間は 担当が変わった周期と 前の周期の削除が済んでいない周期にだけ消す
    if (next !== null && previous === next && !unapplied) return
    releaseTargets(next)
  }

  // 取得に失敗した周期の後始末
  // 猶予の内は前回の担当を据え置き 超えたら手放す
  // 担当を持たない周期でも 前回の宛先の削除が済んでいなければ試し直す
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
    // 担当名を持たないプロセスでは どのチャンネル名とも一致しないので REST を呼ばない
    // 担当名は起動時に決まり 途中で変わらないため 毎周期の一覧取得は rate limit の枠を使うだけになる
    if (!deps.owner) return
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
