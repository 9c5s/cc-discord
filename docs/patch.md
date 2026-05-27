# Discord plugin: 入力中(typing)表示の継続パッチ

Claude Code の Discord channel plugin (`discord@claude-plugins-official`) に加えたローカル改変の記録。
**公式 plugin のキャッシュを直接編集しているため、`/plugin update` や再インストールで失われる。**
リバートされたら本書の「変更箇所」を新バージョンの `server.ts` に再適用する。

## 背景・目的

Discord の typing indicator (「入力中...」) は `sendTyping()` 呼び出しから約10秒で自動的に消える。
plugin 標準では inbound 受信時に1回だけ `sendTyping()` を呼ぶため、Claude の返信生成が10秒を超えると
途中で表示が消える。返信完了まで継続表示するよう、定期再送するパッチを当てた。

## 対象ファイル

`~/.claude/plugins/cache/claude-plugins-official/discord/<version>/server.ts`

- 現行 version: `0.0.4`
- Windows 実パス: `~\.claude\plugins\cache\claude-plugins-official\discord\0.0.4\server.ts`
- **バージョンディレクトリ (`0.0.4`) は plugin 更新で変わる**ので、更新後は新しいバージョンの `server.ts` に当て直す。

## 変更箇所 (3 箇所)

### 1. ヘルパーとタイマー状態の追加

`const dmChannelUsers = new Map<string, string>()` の直後 (`function noteSent` の前) に追加:

```typescript
// Keep the "typing…" indicator alive until all in-flight replies finish. Discord
// clears typing after ~10s, so a single sendTyping() vanishes mid-think on longer
// answers. We re-send on an interval per channel and ref-count in-flight messages:
// each inbound bumps pending, each reply drops it, and we stop only at zero — so a
// second message arriving mid-think doesn't kill the indicator. A safety timeout
// caps a never-answered loop (10 min).
type TypingState = {
  timer: ReturnType<typeof setInterval>
  guard: ReturnType<typeof setTimeout>
  pending: number
}
const typingTimers = new Map<string, TypingState>()
const TYPING_RESEND_MS = 8_000
const TYPING_MAX_MS = 10 * 60_000

function startTyping(channel: Message['channel']): void {
  if (!('sendTyping' in channel)) return
  const id = channel.id
  const existing = typingTimers.get(id)
  if (existing) {
    // Another message arrived while still answering an earlier one — keep the
    // indicator running and remember there's more work in flight.
    existing.pending++
    return
  }
  const send = () => {
    void (channel as { sendTyping: () => Promise<unknown> }).sendTyping().catch(() => {})
  }
  send()
  const timer = setInterval(send, TYPING_RESEND_MS)
  timer.unref?.()
  const guard = setTimeout(() => clearTyping(id), TYPING_MAX_MS)
  guard.unref?.()
  typingTimers.set(id, { timer, guard, pending: 1 })
}

function stopTyping(chatId: string): void {
  const entry = typingTimers.get(chatId)
  if (!entry) return
  entry.pending--
  if (entry.pending > 0) return
  clearTyping(chatId)
}

function clearTyping(chatId: string): void {
  const entry = typingTimers.get(chatId)
  if (!entry) return
  clearInterval(entry.timer)
  clearTimeout(entry.guard)
  typingTimers.delete(chatId)
}
```

### 2. inbound 受信時に typing を開始

messageCreate ハンドラ内の、元はこうなっている箇所:

```typescript
  // Typing indicator — signals "processing" until we reply (or ~10s elapses).
  if ('sendTyping' in msg.channel) {
    void msg.channel.sendTyping().catch(() => {})
  }
```

を、こう置き換える:

```typescript
  // Typing indicator — kept alive until reply() runs (see startTyping). Discord
  // clears typing after ~10s, so we re-send on an interval instead of just once.
  startTyping(msg.channel)
```

### 3. reply 時に typing を停止

`mcp.setRequestHandler(CallToolRequestSchema, ...)` の `case 'reply':` で、`chat_id` 取得直後に
`stopTyping(chat_id)` を 1 行追加:

```typescript
      case 'reply': {
        const chat_id = args.chat_id as string
        stopTyping(chat_id)        // ← この 1 行を追加
        const text = args.text as string
        // ...以下は元のまま
```

## パラメータ

| 定数 | 値 | 意味 |
| --- | --- | --- |
| `TYPING_RESEND_MS` | `8_000` (8秒) | 再送間隔。Discord の ~10秒切れより短くする必要がある |
| `TYPING_MAX_MS` | `10 * 60_000` (10分) | 安全弁。reply が来なくてもこの時間で停止し、無限ループを防ぐ |

## 注意すべきポイント

- **参照カウント方式**: 複数メッセージを同時処理中でも typing が消えないよう、inbound で pending++ / reply で pending-- / 0 で停止する (`startTyping` / `stopTyping` / `clearTyping` の3関数)。これにより「思考中に別メッセージを投げると入力中表示が消える」不具合を解消。注意: Claude が reply しないターン(端末作業のみ等)では pending が減らず、安全弁(10分)まで typing が残ることがある。
- **反映には再起動が必要**: channel server は起動時に `server.ts` を読む。編集後は Claude Code を
  `claude --channels plugin:discord@claude-plugins-official` で起動し直す。
- **検証**: `bun build "<server.ts のパス>" --target node --outfile <tmp>` でトランスパイルが通れば構文 OK
  (型は bun では無視されるが、本パッチは実行時も問題ない)。検証後の一時ファイルは削除する。
- **plugin 更新で消える**: `/plugin update` や再インストールでキャッシュが置き換わると失われる。
  その場合は本書の 3 箇所を新バージョンの `server.ts` に再適用する。
- **channels 自体の前提**: そもそも channels が動くには `DISABLE_TELEMETRY` を外しておく必要がある
  (settings.json から削除済み)。詳細はメモリ `claude-code-channels-disable-telemetry-blocks-flag` 参照。
- **恒久化**: 根本的には upstream (`anthropics/claude-plugins-official` の `external_plugins/discord/server.ts`)
  に PR を出すのが確実。

## 関連

- メモリ: `discord-plugin-typing-continuation-patch` (本書を参照している)
- メモリ: `claude-code-channels-disable-telemetry-blocks-flag` (channels が動く前提)
