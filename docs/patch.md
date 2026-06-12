# Discord plugin server.ts ローカル改変記録

Claude Code の Discord channel plugin (`discord@claude-plugins-official`) に加えたローカル改変の記録。
**公式 plugin のキャッシュを直接編集しているため、`/plugin update` や再インストールで失われる。**
リバートされたら本書の各パッチを新バージョンの `server.ts` に再適用する。

## 対象ファイル

`~/.claude/plugins/cache/claude-plugins-official/discord/<version>/server.ts`

- 現行 version: `0.0.4`
- **バージョンディレクトリ (`0.0.4`) は plugin 更新で変わる**ので、更新後は新しいバージョンの `server.ts` に当て直す。

---

## パッチ A: 入力中(typing)表示の継続

### 背景・目的

Discord の typing indicator (「入力中...」) は `sendTyping()` 呼び出しから約10秒で自動的に消える。
plugin 標準では inbound 受信時に1回だけ `sendTyping()` を呼ぶため、Claude の返信生成が10秒を超えると
途中で表示が消える。返信完了まで継続表示するよう、定期再送するパッチを当てた。

### 変更箇所 (3 箇所)

#### 1. ヘルパーとタイマー状態の追加

`const dmChannelUsers = new Map<string, string>()` の直後 (`function noteSent` の前) に追加:

```typescript
// Keep the "typing…" indicator alive until all in-flight replies finish. Discord
// clears typing after ~10s, so a single sendTyping() vanishes mid-think on longer
// answers. We re-send on an interval per channel and ref-count in-flight messages:
// each inbound bumps pending, each reply drops it, and we stop only at zero — so a
// second message arriving mid-think doesn't kill the indicator. A safety timeout
// caps a never-answered loop (10 min)
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

#### 2. inbound 受信時に typing を開始

messageCreate ハンドラ内の、元はこうなっている箇所:

```typescript
  // Typing indicator — signals "processing" until we reply (or ~10s elapses)
  if ('sendTyping' in msg.channel) {
    void msg.channel.sendTyping().catch(() => {})
  }
```

を、こう置き換える:

```typescript
  // Typing indicator — kept alive until reply() runs (see startTyping) Discord
  // clears typing after ~10s, so we re-send on an interval instead of just once.
  startTyping(msg.channel)
```

#### 3. reply 時に typing を停止

`mcp.setRequestHandler(CallToolRequestSchema, ...)` の `case 'reply':` で、`chat_id` 取得直後に
`clearTyping(chat_id)` を 1 行追加(無条件停止)。

```typescript
      case 'reply': {
        const chat_id = args.chat_id as string
        clearTyping(chat_id)       // ← この 1 行を追加 (reply で無条件停止)
        const text = args.text as string
        // ...以下は元のまま
```

### パラメータ

| 定数 | 値 | 意味 |
| --- | --- | --- |
| `TYPING_RESEND_MS` | `8_000` (8秒) | 再送間隔。Discord の ~10秒切れより短くする必要がある |
| `TYPING_MAX_MS` | `10 * 60_000` (10分) | 安全弁。reply が来なくてもこの時間で停止し、無限ループを防ぐ |

### 注意すべきポイント

- **無条件停止方式**: reply 時に `clearTyping` を呼んで typing を即停止する。`startTyping` は重複 inbound に対し `pending++` するが、reply の経路では `stopTyping` (`pending--`) を使わず `clearTyping` で一括停止する。これにより interrupt 由来の永続 pending(reply されないターンがあると pending が減らず安全弁 10 分まで残る)を根絶し「タスク完了後も入力中が消えない」事象を解消する。トレードオフ: ユーザー連続入力中に最初の reply で typing がいったん消え、2 つ目以降の inbound の処理は typing 無しで進む(一般的な bot 体験で違和感は少ない)。`stopTyping` 関数自体は ref-counting の選択肢として残してあり、安全弁 10 分のフォールバックも維持。
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

### 関連

- メモリ: `discord-plugin-typing-continuation-patch` (本書を参照している)
- メモリ: `claude-code-channels-disable-telemetry-blocks-flag` (channels が動く前提)

---

## パッチ B: 複数セッション自動ルーティング

### 背景・目的

複数の Claude Code セッションが同一 Discord bot に接続すると、全セッションが全メッセージを受信して
重複処理が発生する。各セッションが起動ディレクトリ名(プロジェクト名)に対応する担当チャンネルのみを
処理するよう gate で振り分けるパッチを当てた。DM は `cc-discord` セッション固定で1セッションに集約する。

### 変更箇所 (3 箇所)

#### 改変1(Task 3 Step 1): normalizeName 関数 + ルーティング変数の追加

`const INBOX_DIR = join(STATE_DIR, 'inbox')` の直後(行64の次)に挿入:

```typescript
// --- Multi-session routing (Task #2) ---
// 起動ディレクトリ名を正規化 CLAUDE_PROJECT_DIR は MCP server 環境に設定される
function normalizeName(input: string): string {
  return input.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '')
}
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR ?? ''
const OWNER_NAME = PROJECT_DIR ? normalizeName(PROJECT_DIR.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '') : ''
// DM を担当するのは正規化名が 'cc-discord' のセッション
const OWNS_DM = OWNER_NAME === 'cc-discord'
// ready 後に解決する担当 guild チャンネルID(なければ null)
let ownedChannelId: string | null = null
```

- `CLAUDE_PROJECT_DIR` は MCP server 起動時の環境変数で、Claude Code が起動ディレクトリを渡す。
- `OWNER_NAME` はプロジェクトディレクトリ名を正規化したもの(例: `cc-discord`)。
- `OWNS_DM` は DM 担当フラグ。`cc-discord` セッションのみ true になる。
- `ownedChannelId` は ready イベントで解決する。

#### 改変2(Task 3 Step 2): ready ハンドラで担当チャンネルを解決し routes に書き込む

元の `client.once('ready', ...)` は同期ハンドラで `gateway connected` ログのみを出力していた。
これを非同期ハンドラに変更し、担当チャンネルを解決して routes ファイルに書き込む処理を追加した:

```typescript
// 担当チャンネルの解決処理. ready 時と定期再解決の両方から呼ぶ
// access.json への許可追加やチャンネル改名を再起動なしで反映するため 60 秒毎に再評価し
// 結果が変化したときだけログと route 更新を行う
let lastResolvedChannelId: string | null | undefined
function resolveOwnedChannel(c: any): void {
  // guild チャンネルから正規化名一致を探す
  // 同名のカテゴリ/ボイス/フォーラム/スレッドを誤って担当にしないよう guild テキストチャンネルに限定する
  // さらに access.json で許可済み (groups 登録済み) のチャンネルに限定する
  // 進捗送信 (watch/notify) は gate を通らず REST で直接投稿するため ここで許可リストを
  // 強制しないと 同名の未許可チャンネルへセッション内容が流出しうる
  const access = loadAccess()
  const matches = c.channels.cache.filter(
    (ch: any) => ch.type === ChannelType.GuildText && (ch.id in access.groups) && 'name' in ch && typeof ch.name === 'string' && normalizeName(ch.name) === OWNER_NAME,
  )
  const first = matches.first()
  const resolved = first ? first.id : null
  if (resolved === lastResolvedChannelId) return
  lastResolvedChannelId = resolved
  ownedChannelId = resolved
  if (first) {
    // routes/<OWNER_NAME> に担当チャンネルIDを書く(hook/監視が読む)
    try {
      const rdir = join(STATE_DIR, 'routes')
      mkdirSync(rdir, { recursive: true, mode: 0o700 })
      writeFileSync(join(rdir, OWNER_NAME), first.id, { encoding: 'utf8', mode: 0o600 })
    } catch (err) {
      process.stderr.write(`discord channel: failed to write route: ${err}\n`)
    }
    process.stderr.write(`discord channel: routing to #${first.name} (${first.id}); DM=${OWNS_DM}\n`)
  } else {
    // 一致チャンネルが無い場合は前回実行の stale な route を削除する
    // 残すと改名/削除後も watch/notify が旧チャンネル ID へ進捗を投稿し続ける
    try { rmSync(join(STATE_DIR, 'routes', OWNER_NAME), { force: true }) } catch { /* 削除失敗は無視する */ }
    // progress-thread も独立した送信先として残るため 同じ理由で削除する
    try { rmSync(join(STATE_DIR, 'progress-thread', OWNER_NAME), { force: true }) } catch { /* 削除失敗は無視する */ }
    process.stderr.write(`discord channel: no channel named '${OWNER_NAME}' — guild routing off (DM=${OWNS_DM})\n`)
  }
}

client.once('ready', async c => {
  process.stderr.write(`discord channel: gateway connected as ${c.user.tag}\n`)
  if (!OWNER_NAME) {
    process.stderr.write('discord channel: CLAUDE_PROJECT_DIR unset — routing disabled (handling all)\n')
    return
  }
  resolveOwnedChannel(c)
  // /discord:access による許可追加やチャンネル改名を再起動なしで拾うための定期再解決
  const timer = setInterval(() => resolveOwnedChannel(c), 60_000)
  ;(timer as any).unref?.()
})
```

- routes ディレクトリ: `~/.claude/channels/discord/routes/` (パーミッション 0o700)
- routes ファイル: `routes/<OWNER_NAME>` にチャンネルIDを書く(パーミッション 0o600)
- チャンネル名の正規化照合で担当を決定し、`ownedChannelId` に代入する。
- 一致チャンネルが無い場合は stale な `routes/<OWNER_NAME>` を削除する(チャンネル改名/削除後に
  旧チャンネルへ進捗が流れ続けるのを防ぐ。2026-06-12 PR #1 レビュー指摘で追加)。

#### 改変3(Task 4): gate 関数にルーティングゲートを追加

`gate()` 関数内の `const isDM = msg.channel.type === ChannelType.DM` の直後(行309の次)に挿入:

```typescript
  // --- Multi-session routing gate (Task #2) ---
  if (OWNER_NAME) {
    if (isDM) {
      // DM は cc-discord セッションのみが担当する規約 他セッションは allowlist 済みでも drop し DM を1セッションに集約する(重複防止)
      if (!OWNS_DM) return { action: 'drop' }
    } else {
      // guild: 担当チャンネル以外は drop. スレッドは親で判定
      const ch: any = msg.channel
      const cid = ch.isThread?.() ? (ch.parentId ?? msg.channelId) : msg.channelId
      if (ownedChannelId === null || cid !== ownedChannelId) return { action: 'drop' }
    }
  }
```

- `OWNER_NAME` が空(CLAUDE_PROJECT_DIR 未設定)の場合はゲートをスキップし全メッセージを処理する(後方互換)。
- DM はプロジェクト名 `cc-discord` のセッション固定とし、他セッションが重複受信しないよう drop する。
- guild チャンネルは `ownedChannelId` との照合で振り分ける。スレッドは親チャンネルIDで判定する。

### 注意すべきポイント

- **plugin 更新で消える**: `/plugin update` や再インストールでキャッシュが置き換わると失われる。
  その場合は本書の 3 箇所を新バージョンの `server.ts` に再適用する。
- **反映には再起動が必要**: channel server は起動時に `server.ts` を読む。編集後は Claude Code を
  `claude --channels plugin:discord@claude-plugins-official` で起動し直す。
- **検証**: `bun build "<server.ts のパス>" --target node --outfile <tmp>` でトランスパイルが通れば構文 OK。
  検証後の一時ファイルは削除する。
- **routes ファイルのパーミッション**: routes ディレクトリは 0o700、routes ファイルは 0o600 で作成する。
  チャンネルIDが平文で書かれるため、他ユーザーから読まれないよう制限する。
- **OWNER_NAME が空の場合**: `CLAUDE_PROJECT_DIR` 未設定(単独セッション運用等)では全メッセージを処理する。
  既存の単独セッション運用と後方互換性を保っている。

### 関連

- メモリ: `cc-discord-channel-enhancements-plan` (本改変の設計計画を参照している)

---

## パッチ C: 進捗ストリーミング用 per-inbound スレッド作成

### 背景・目的

途中経過 (tool 通知、thinking、text) を親チャンネルに直接流すと会話本筋に埋もれる。
inbound メッセージ毎に新規スレッドを立てて、Claude の途中経過はそのスレッド内に蓄積する。
最終的な `reply` ツール経由の返信は引き続き親チャンネル (または DM) に投稿される。

### 変更箇所

`messageCreate` ハンドラ内、`startTyping(msg.channel)` の直後に挿入 (現 line 933 付近):

```typescript
  // --- Per-inbound progress thread (Patch C) ---
  // 各 inbound で進捗用スレッドを立て tool/text の途中経過をそこへ流す
  // DM はスレッド作成不可なので channel ID をそのまま書き notify は DM に直接投稿する
  if (OWNER_NAME) {
    const ptDir = join(STATE_DIR, 'progress-thread')
    try { mkdirSync(ptDir, { recursive: true, mode: 0o700 }) } catch { /* dir 作成失敗は次の write で検知される */ }
    const ptFile = join(ptDir, OWNER_NAME)

    // --- inbound 多重処理防止ロック ---
    // Claude Code はセッション毎に MCP server として本プロセスを起動するため 同名ディレクトリの
    // セッション (resume の daemon セッション等を含む) が複数あると 同じ OWNER_NAME の server が
    // 同時に Gateway へ接続し 1 つの inbound を各プロセスが処理してしまう
    // スレッド内の inbound や DM も対象になるようチャンネル種別の分岐より前に
    // message_id 名のロックを wx (排他作成) で取得し 取れなかったプロセスは inbound ごと破棄する
    const lockFile = join(ptDir, `${OWNER_NAME}.lock-${msg.id}`)
    try {
      writeFileSync(lockFile, String(process.pid), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      // 60 秒より古いロックを掃除する 直近の別 inbound を他プロセスが処理中の可能性があるため
      // 新しいものは残す
      try {
        const now = Date.now()
        for (const f of readdirSync(ptDir)) {
          if (!f.startsWith(`${OWNER_NAME}.lock-`) || f === `${OWNER_NAME}.lock-${msg.id}`) continue
          const fp = join(ptDir, f)
          try { if (now - statSync(fp).mtimeMs > 60_000) rmSync(fp, { force: true }) } catch { /* 競合は無害 */ }
        }
      } catch { /* 掃除失敗は無害 */ }
    } catch (err) {
      // EEXIST は他プロセスがこの inbound を取得済み (そのプロセスがスレッドを作り inbound も処理する)
      // 敗者が処理を続けると同じメッセージへ二重に応答するため typing を止めて inbound ごと破棄する
      if ((err as { code?: string }).code === 'EEXIST') {
        clearTyping(chat_id)
        return
      }
      // それ以外 (dir 不在等) はロック機構が使えないだけなので従来どおり続行する
    }

    if (msg.channel.type === ChannelType.DM) {
      try { writeFileSync(ptFile, chat_id, { encoding: 'utf8', mode: 0o600 }) } catch (err) {
        process.stderr.write(`discord channel: failed to write progress-thread (DM): ${err}\n`)
      }
    } else if ('threads' in msg.channel) {
      // スレッド名: [MM/DD HH:MM] + 本文(空白正規化, 80字超は79字+…, 空は progress)
      // cc-discord plugin/src/summarize.ts の threadName() と同じロジックをインライン化している
      const pad = (n: number) => String(n).padStart(2, '0')
      const dt = msg.createdAt
      const stamp = `${pad(dt.getMonth() + 1)}/${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`
      const nameBody = (msg.content || '').replace(/\s+/g, ' ').trim()
      // 絵文字などの非 BMP 文字でサロゲートペアを分断しないようコードポイント単位で切る
      const namePoints = [...nameBody]
      const nameClipped = namePoints.length > 80 ? namePoints.slice(0, 79).join('') + '…' : nameBody
      const name = `[${stamp}] ${nameClipped || 'progress'}`
      try {
        // 親チャンネルに @silent (SUPPRESS_NOTIFICATIONS, ビット 12 = 4096) で
        // ゼロ幅スペース (U+200B) 1 文字のアンカーを bot 自身として投げ それを起点に public スレッドを作る
        // - アンカーの作者が bot なのでユーザーはスレッドの参加者にならず per-thread のフォローが付かない
        // - public なので所有者はクリックで普通に閲覧できる (管理権限不要)
        // - アンカーがある作成方式なので親チャンネルの type 18 (started a thread) 行は出ない
        // - flags でアンカー自身の push 通知も抑止する
        // 親チャンネルでアンカーを目立たせないよう ZWSP 単体(視覚的に空)を採用している
        // ASCII space と NBSP (U+00A0) はいずれも Discord API 側で trailing trim されるため不可
        const anchor = await (msg.channel as any).send({
          content: '​',
          flags: 1 << 12,
        })
        const thread = await anchor.startThread({
          name,
          autoArchiveDuration: 60,
          reason: 'cc-discord progress streaming',
        })
        writeFileSync(ptFile, thread.id, { encoding: 'utf8', mode: 0o600 })
      } catch (err) {
        process.stderr.write(`discord channel: failed to create progress thread: ${err}\n`)
        try { writeFileSync(ptFile, chat_id, { encoding: 'utf8', mode: 0o600 }) } catch { /* 完全失敗時は次の inbound で再試行される */ }
      }
    } else {
      try { writeFileSync(ptFile, chat_id, { encoding: 'utf8', mode: 0o600 }) } catch { /* 同上 */ }
    }
  }
```

### 接続点 (cc-discord 側)

`plugin/src/notify.ts` の `progressChannelId()` がこのファイル (`~/.claude/channels/discord/progress-thread/<owner>`) を読み、`postMessage` の宛先に使う。

- スレッド ID があれば → スレッドに投稿 (途中経過)
- DM の場合は DM channel ID → DM に投稿
- ファイル無 or 空 → `channelId()` (親チャンネル) にフォールバック

`watch.ts` (transcript 監視) は text と tool_use の両方を抽出し `notify` 経由で投稿するため、自動的に新しい宛先に切り替わる。`reply` ツールは MCP 経由で `chat_id` を直接受けるため本パッチの影響なし。

### パラメータ

| 定数 | 値 | 意味 |
| --- | --- | --- |
| `autoArchiveDuration` | `60` (1 時間) | Discord のスレッド自動アーカイブ時間。最短値を採用し放置スレッドが速やかに畳まれるようにする |
| スレッド名 | `[MM/DD HH:MM] <本文>` | 日時プレフィックス + inbound 本文。本文は空白正規化し 80 字超は 79 字 + …。空は progress。プレフィックス込みで Discord 上限 100 字以内 |

### 注意すべきポイント

- **bot 投稿 @silent アンカー + public スレッド方式**: 旧実装は (a) `msg.startThread` で inbound 自体をアンカー → アンカー作者であるユーザーが毎回スレッド参加者となり per-thread のフォロー通知が付く副作用、(b) `threads.create({ type: PrivateThread })` → フォローは消えるが閲覧にスレッド管理権限が要りオーナー以外辛い、という 2 案を経た。最終的に親チャンネルに bot 自身が `SUPPRESS_NOTIFICATIONS` (ビット 12 = 4096) 付きでゼロ幅スペース (U+200B) 1 文字のアンカーを投稿し、そのアンカーから `startThread` で public スレッドを立てる方式に到達。利点: アンカー作者が bot なのでユーザーはスレッド参加者にならずフォロー通知が付かない / public なので所有者はクリックで閲覧できる (管理権限不要) / アンカー付き作成なので親チャンネルの type 18 (started a thread) システム行は出ない / アンカー自身も `@silent` で push が飛ばない。アンカー本文は親チャンネルでの存在感を最小化するため視覚的に空(ZWSP 1 文字)とする。ASCII space と NBSP (U+00A0) は Discord 側で trailing trim されるため不可、ZWSP は Format カテゴリで trim 対象外として残る。トレードオフ: 親チャンネルにゼロ幅の bot メッセージが毎回 1 件残る (ほぼ視認不能)。bot は他ユーザーの per-thread 通知レベルを変更する API を公式に持たないため、これが「ユーザー側設定に頼らずに通知を抑止する」唯一の API パターンとなる。なお Discord クライアントは `THREAD_CREATE` gateway イベントに対し独自にプッシュ通知を出す仕様で、bot 側で API レベルにこれを抑止する手段は存在しない(調査済)。完全に消したい場合はチャンネル単位の Notification Override で「Notify me of new threads」を OFF にする必要がある。
- **inbound 毎に新規スレッドを作る** (案 Q)。連続入力中の追加 inbound でも別スレッドが立つため、進捗の流れがメッセージ単位で分かれる。`threads.create` はアンカー制約が無く各 inbound で独立にスレッドを立てる (失敗したら catch で親チャンネルにフォールバック)。
- **message_id ロックで多重作成を防止** (2026-06-10 追加)。Claude Code はセッション毎に MCP server として server.ts を起動し、`--channels` の有無に関わらず各プロセスが Gateway に接続して messageCreate を受ける。resume / fork-session のバックグラウンド daemon セッションや Claude Desktop のセッションも含め、同名ディレクトリのセッションが N 個あると同じ inbound に対しスレッドが N 個立っていた (2026-06-10 に実際に発生。アンカー 3 連投を確認)。対策として `progress-thread/<OWNER_NAME>.lock-<message_id>` を `flag: 'wx'` (排他作成) で書けた 1 プロセスだけがスレッドを作成する。wx は OS レベルでアトミック (Windows + bun で 5 並行 1 勝を検証済)。EEXIST 以外のエラーは従来どおり続行 (進捗喪失よりも多重を許容)。**ロック敗者は typing を止めて inbound ごと破棄する** (2026-06-12 追加。スレッド作成の抑止だけでは敗者プロセスも inbound を処理し重複返信しうるため、ロックを実質のルーティングゲートとして使う)。60 秒より古いロックは勝者が掃除する (直近の別 inbound の処理中ロックを消さないための猶予)。注意: ロックを知らない旧版コードのプロセスが残っている間は多重が残るため、反映には**全セッションの再起動**が必要。
- **DM はスレッド作れない** (Discord 仕様)。channel ID をそのまま `progress-thread/<owner>` に書き、notify は DM に直接投稿する。
- **OWNER_NAME 空のセッションは何もしない**。後方互換性として `CLAUDE_PROJECT_DIR` 未設定の単独セッション運用に影響を与えない。
- **作成失敗時は親チャンネルにフォールバック**。Bot 権限不足 (`Send Messages` / `Create Public Threads`)、レート制限などで `send` か `startThread` が throw した場合、`chat_id` を書いて progress も親チャンネルに流す。
- **反映には再起動が必要**: channel server は起動時に `server.ts` を読む。編集後は Claude Code を
  `claude --channels plugin:discord@claude-plugins-official` で起動し直す。
- **検証**: `bun build "<server.ts のパス>" --target node --outfile <tmp>` でトランスパイルが通れば構文 OK。
- **plugin 更新で消える**: `/plugin update` や再インストールでキャッシュが置き換わると失われる。本書のコードを新バージョンの `server.ts` に再適用する。
- **bot 権限**: アンカー投稿に `Send Messages`、スレッド作成に `Create Public Threads` が必要。`threads` を持たないチャンネル種 (forum 等) では fallback パスが動作する。

### 関連

- `plugin/src/notify.ts` の `progressChannelId()` 関数
- メモリ: `cc-discord-channel-enhancements-plan` (本改変の設計計画を参照している)

---

## パッチ D: 全送信経路の allowed_mentions 無効化

### 背景・目的

コードブロックやインラインコードの中の `@everyone` / `<@USER_ID>` は**表示上は raw テキストのままだが、
Discord API はメッセージ content 全体から mention を解析して ping を発生させる** (2026-06-10 実機で確認。
インラインコードで `@everyone` を含む reply がメンションとして受信ボックスに入った)。
コード装飾はメンション ping の防御にならないため、bot の全送信経路で `allowed_mentions` を無効化する。
詳細は `docs/discord-text-formatting.md`。

### 変更箇所 (2 箇所)

#### 1. reply ツールの送信 (`case 'reply'` 内の `ch.send`)

```ts
            const sent = await ch.send({
              content: chunks[i],
              // コードブロック内の @everyone や <@id> も API は mention として解析し ping するため
              // content 由来のメンション解決を全面的に無効化する (docs/discord-text-formatting.md)
              allowedMentions: { parse: [] },
              ...(i === 0 && files.length > 0 ? { files } : {}),
              ...(shouldReplyTo
                ? { reply: { messageReference: reply_to, failIfNotExists: false } }
                : {}),
            })
```

#### 2. edit_message ツールの編集 (`case 'edit_message'` 内の `msg.edit`)

```ts
        // 編集でも mentions は再解析されるため reply と同様にメンション解決を無効化する
        const edited = await msg.edit({ content: args.text as string, allowedMentions: { parse: [] } })
```

### 注意すべきポイント

- **`allowedMentions` を指定すると `replied_user` も既定で false になる** (Discord API 仕様)。
  `replyToMode: 'first'` に戻しても引用 reply の相手 ping は発生しなくなるため、
  access.json の `replyToMode: 'off'` (ping 対症療法) は不要になったら戻してよい。
- watch 経由の進捗通知は `plugin/src/notify.ts` 側で同じ対処済み (`allowed_mentions: { parse: [] }`)。
- ペアリング完了通知 (`Paired! ...`) と ZWSP アンカーは固定文字列のため対象外とした。
- **進捗スレッドは owner 単位の単一ストリーム**: progress-thread/<owner> は inbound 毎に上書きされるため、
  同一プロジェクトで前ターンの進捗が流れている最中に次の inbound が来ると、前ターン残りの進捗は
  新しいスレッドへ流れ込む。セッション=単一ストリームという意図したトレードオフであり、
  inbound 単位の厳密な紐付けはしない (2026-06-12 PR レビューで指摘、設計判断として記録)。
- **反映には全セッションの再起動が必要** (server.ts はセッション毎に常駐するため)。
- **plugin 更新で消える**: 新バージョンの `server.ts` に再適用する。

### 関連

- `docs/discord-text-formatting.md` の調査記録
- `plugin/src/notify.ts` の `postMessage` (watch 経路の同対処)

---

## パッチ E: reply 末尾のステータスブロック付与

### 背景・目的

リプライメッセージの末尾に「ブランチ名 / モデル名+effort / ctx%+5h+7d リミット」の
3行ステータスをコードブロックで表示する。データ源は Claude Code が statusLine コマンドへ
渡す stdin JSON (rate_limits と context_window はここにしかない)。
`statusline-tee.ts` (settings.json の statusLine で本来のコマンドをラップ) が
`stateDir/statusline/<owner>.txt` に整形済みブロックを書き、server.ts はそれを読んで
reply 末尾に連結するだけにする。揮発する patch 面積を最小化し、整形ロジックは
本リポジトリの `plugin/src/status.ts` (テスト付き) に置く。

### 変更箇所 (2 箇所)

#### 1. ヘルパーの追加 (`let ownedChannelId: string | null = null` の直後)

```ts
// --- Reply status footer (cc-discord パッチ E) ---
// statusline-tee.ts (cc-discord リポジトリ) が stateDir/statusline/<owner>.txt に書く
// 整形済みステータスブロックを reply 末尾に付ける ファイルが無い場合や10分より
// 古い(セッション非アクティブ)場合は付けない 失敗しても reply 本体は止めない
function replyStatusFooter(): string | null {
  try {
    if (!OWNER_NAME) return null
    const f = join(STATE_DIR, 'statusline', `${OWNER_NAME}.txt`)
    if (Date.now() - statSync(f).mtimeMs > 10 * 60 * 1000) return null
    const t = readFileSync(f, 'utf8').trim()
    return t || null
  } catch { return null }
}
```

#### 2. reply ツールのチャンク化 (`case 'reply'` 内)

`const chunks = chunk(text, limit, mode)` を以下に置き換える:

```ts
        // cc-discord パッチ E: リプライ末尾にステータスブロックを付ける
        // チャンカーが footer のコードフェンスを分断しないよう本文だけを chunk し
        // footer は末尾チャンクに収まるなら結合 収まらなければ独立チャンクとして送る
        const footer = replyStatusFooter()
        const chunks = chunk(text, limit, mode)
        if (footer) {
          const lastChunk = chunks[chunks.length - 1]
          if (lastChunk !== undefined && lastChunk.length + 1 + footer.length <= limit) {
            chunks[chunks.length - 1] = `${lastChunk}\n${footer}`
          } else {
            chunks.push(footer)
          }
        }
```

### 注意すべきポイント

- **settings.json 側の前提**: `statusLine.command` が tee でラップされていること。
  例 (`<repo>` は本リポジトリの clone 先。statusline スクリプト部分は自身の設定に置き換える):
  `bun <repo>/plugin/src/statusline-tee.ts uv run ~/.claude/scripts/statusline.py --icons=nerd`
  tee を外すと .txt が更新されなくなり、10分で footer は自然消滅する。
- **owner 単位の last-writer-wins**: 同一プロジェクトでセッションが並走すると最後に statusline を
  描画したセッションの値になる。reply する瞬間は自セッションがアクティブなため実用上は一致する。
- statusline はアクティブなインタラクティブセッションでしか描画されない。headless 等では footer なし。
- **反映には全セッションの再起動が必要** (server.ts はセッション毎に常駐するため)。
- **plugin 更新で消える**: 新バージョンの `server.ts` に再適用する。

### 関連

- `plugin/src/status.ts` (整形ロジック本体、`plugin/test/status.test.ts` でテスト)
- `plugin/src/statusline-tee.ts` (statusline JSON の捕捉と .txt 生成)
