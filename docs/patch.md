# Discord plugin server.ts ローカル改変記録

Claude Code の Discord channel plugin (`discord@claude-plugins-official`) に加えたローカル改変の記録。
**公式 plugin のキャッシュを直接編集しているため、`/plugin update` や再インストールで失われる。**
リバートされたら本書の各パッチを新バージョンの `server.ts` に再適用する。

## 対象ファイル

`~/.claude/plugins/cache/claude-plugins-official/discord/<version>/server.ts`

- 現行 version: `0.0.4`
- Windows 実パス: `~\.claude\plugins\cache\claude-plugins-official\discord\0.0.4\server.ts`
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

#### 2. inbound 受信時に typing を開始

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
// 起動ディレクトリ名を正規化。CLAUDE_PROJECT_DIR は MCP server 環境に設定される。
function normalizeName(input: string): string {
  return input.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '')
}
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR ?? ''
const OWNER_NAME = PROJECT_DIR ? normalizeName(PROJECT_DIR.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '') : ''
// DM を担当するのは正規化名が 'cc-discord' のセッション。
const OWNS_DM = OWNER_NAME === 'cc-discord'
// ready 後に解決する担当 guild チャンネルID(なければ null)。
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
client.once('ready', async c => {
  process.stderr.write(`discord channel: gateway connected as ${c.user.tag}\n`)
  if (!OWNER_NAME) {
    process.stderr.write('discord channel: CLAUDE_PROJECT_DIR unset — routing disabled (handling all)\n')
    return
  }
  // guild チャンネルから正規化名一致を探す。
  const matches = c.channels.cache.filter(
    ch => 'name' in ch && typeof (ch as any).name === 'string' && normalizeName((ch as any).name) === OWNER_NAME,
  )
  const first = matches.first()
  if (first) {
    ownedChannelId = first.id
    // routes/<OWNER_NAME> に担当チャンネルIDを書く(hook/監視が読む)。
    try {
      const rdir = join(STATE_DIR, 'routes')
      mkdirSync(rdir, { recursive: true, mode: 0o700 })
      writeFileSync(join(rdir, OWNER_NAME), first.id, { encoding: 'utf8', mode: 0o600 })
    } catch (err) {
      process.stderr.write(`discord channel: failed to write route: ${err}\n`)
    }
    process.stderr.write(`discord channel: routing to #${(first as any).name} (${first.id}); DM=${OWNS_DM}\n`)
  } else {
    process.stderr.write(`discord channel: no channel named '${OWNER_NAME}' — guild routing off (DM=${OWNS_DM})\n`)
  }
})
```

- routes ディレクトリ: `~/.claude/channels/discord/routes/` (パーミッション 0o700)
- routes ファイル: `routes/<OWNER_NAME>` にチャンネルIDを書く(パーミッション 0o600)
- チャンネル名の正規化照合で担当を決定し、`ownedChannelId` に代入する。

#### 改変3(Task 4): gate 関数にルーティングゲートを追加

`gate()` 関数内の `const isDM = msg.channel.type === ChannelType.DM` の直後(行309の次)に挿入:

```typescript
  // --- Multi-session routing gate (Task #2) ---
  if (OWNER_NAME) {
    if (isDM) {
      // DM は cc-discord セッションのみが担当する規約。他セッションは allowlist 済みでも drop し DM を1セッションに集約する(重複防止)。
      if (!OWNS_DM) return { action: 'drop' }
    } else {
      // guild: 担当チャンネル以外は drop。スレッドは親で判定。
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
  // 各 inbound で進捗用スレッドを立て、tool/text の途中経過をそこへ流す。
  // DM はスレッド作成不可なので channel ID をそのまま書き、notify は DM に直接投稿する。
  if (OWNER_NAME) {
    const ptDir = join(STATE_DIR, 'progress-thread')
    try { mkdirSync(ptDir, { recursive: true, mode: 0o700 }) } catch { /* dir 作成失敗は次の write で検知される */ }
    const ptFile = join(ptDir, OWNER_NAME)
    if (msg.channel.type === ChannelType.DM) {
      try { writeFileSync(ptFile, chat_id, { encoding: 'utf8', mode: 0o600 }) } catch (err) {
        process.stderr.write(`discord channel: failed to write progress-thread (DM): ${err}\n`)
      }
    } else if ('threads' in msg.channel) {
      // --- スレッド作成の多重防止ロック ---
      // Claude Code はセッション毎に MCP server として本プロセスを起動するため、同名ディレクトリの
      // セッション (resume の daemon セッション等を含む) が複数あると、同じ OWNER_NAME の server が
      // 同時に Gateway へ接続し、1 つの inbound に対して各プロセスがスレッドを多重作成してしまう。
      // message_id 名のロックファイルを wx (排他作成) で書けた 1 プロセスだけが作成を実行する。
      const lockFile = join(ptDir, `${OWNER_NAME}.lock-${msg.id}`)
      let proceed = false
      try {
        writeFileSync(lockFile, String(process.pid), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        proceed = true
      } catch (err) {
        // EEXIST は他プロセスが取得済み (そのプロセスがスレッドを作り ptFile を書く)。
        // それ以外 (dir 不在等) はロック機構が使えないだけなので従来どおり続行する。
        proceed = (err as { code?: string }).code !== 'EEXIST'
      }
      if (proceed) {
        // 60 秒より古いロックを掃除する。直近の別 inbound を他プロセスが処理中の可能性があるため
        // 新しいものは残す。
        try {
          const now = Date.now()
          for (const f of readdirSync(ptDir)) {
            if (!f.startsWith(`${OWNER_NAME}.lock-`) || f === `${OWNER_NAME}.lock-${msg.id}`) continue
            const fp = join(ptDir, f)
            try { if (now - statSync(fp).mtimeMs > 60_000) rmSync(fp, { force: true }) } catch { /* 競合は無害 */ }
          }
        } catch { /* 掃除失敗は無害 */ }
        // スレッド名: [MM/DD HH:MM] + 本文(空白正規化, 80字超は79字+…, 空は progress)。
        // cc-discord plugin/src/summarize.ts の threadName() と同じロジックをインライン化している。
        const pad = (n: number) => String(n).padStart(2, '0')
        const dt = msg.createdAt
        const stamp = `${pad(dt.getMonth() + 1)}/${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`
        const nameBody = (msg.content || '').replace(/\s+/g, ' ').trim()
        const nameClipped = nameBody.length > 80 ? nameBody.slice(0, 79) + '…' : nameBody
        const name = `[${stamp}] ${nameClipped || 'progress'}`
        try {
          // 親チャンネルに @silent (SUPPRESS_NOTIFICATIONS, ビット 12 = 4096) で
          // ゼロ幅スペース (U+200B) 1 文字のアンカーを bot 自身として投げ、それを起点に public スレッドを作る。
          // - アンカーの作者が bot なのでユーザーはスレッドの参加者にならず per-thread のフォローが付かない
          // - public なので所有者はクリックで普通に閲覧できる (管理権限不要)
          // - アンカーがある作成方式なので親チャンネルの type 18 (started a thread) 行は出ない
          // - flags でアンカー自身の push 通知も抑止する
          // 親チャンネルでアンカーを目立たせないよう ZWSP 単体(視覚的に空)を採用している。
          // ASCII space と NBSP (U+00A0) はいずれも Discord API 側で trailing trim されるため不可。
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
- **message_id ロックで多重作成を防止** (2026-06-10 追加)。Claude Code はセッション毎に MCP server として server.ts を起動し、`--channels` の有無に関わらず各プロセスが Gateway に接続して messageCreate を受ける。resume / fork-session のバックグラウンド daemon セッションや Claude Desktop のセッションも含め、同名ディレクトリのセッションが N 個あると同じ inbound に対しスレッドが N 個立っていた (2026-06-10 に実際に発生。アンカー 3 連投を確認)。対策として `progress-thread/<OWNER_NAME>.lock-<message_id>` を `flag: 'wx'` (排他作成) で書けた 1 プロセスだけがスレッドを作成する。wx は OS レベルでアトミック (Windows + bun で 5 並行 1 勝を検証済)。EEXIST 以外のエラーは従来どおり続行 (進捗喪失よりも多重を許容)。60 秒より古いロックは勝者が掃除する (直近の別 inbound の処理中ロックを消さないための猶予)。注意: ロックを知らない旧版コードのプロセスが残っている間は多重が残るため、反映には**全セッションの再起動**が必要。
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
