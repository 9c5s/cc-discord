# Discord plugin server.ts ローカル改変記録

Claude Code の Discord channel plugin (`discord@claude-plugins-official`) に加えたローカル改変の意図と注意点の記録。
**コードの実体は `patches/<version>.patch` (unified diff) にあり、本書はコードを持たない。**
公式 plugin のキャッシュを直接編集しているため、`/plugin update` や再インストールで失われる。
失われたら下記の機械適用で再適用する。

## 機械適用 (patches/ + patch-server)

- 適用: `bun plugin/src/patch-server.ts`
  - キャッシュ (`~/.claude/plugins/cache/claude-plugins-official/discord/<version>/`) の最新バージョンを対象に `patches/<version>.patch` を `git apply` する
  - 適用済みなら何もしない (逆適用チェックによる冪等判定)
  - バージョン一致の .patch が無ければ手持ちの最新でフォールバック試行し、成功すれば `patches/<新version>.patch` として自動保存するのでコミットする
  - 適用前の素は同ディレクトリに `server.ts.orig` として保全される (--make の基準になるため消さない)
  - 適用後は `bun build` で構文検証され、失敗時は自動で復元される
  - **反映には全セッションの再起動が必要** (server.ts はセッション毎の channel server プロセスが起動時に読むため)
- 再生成: `bun plugin/src/patch-server.ts --make`
  - `server.ts.orig` (無ければ package.json の version が一致する場合に限り marketplace の素 `~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/discord/server.ts`) と現キャッシュの diff から `patches/<version>.patch` を作る
  - キャッシュを手動修正した後やパッチを改良した後に実行してコミットする
  - 生成される diff のヘッダは `a/server.ts` に正規化され、ローカル絶対パスは含まれない (公開リポジトリのため)
- パッチが当たらない場合 (本家の大改修時): 本書の各パッチの意図を読みながら新 server.ts に手動適用し、`--make` で .patch 化する
- 前提: そもそも channels が動くには `DISABLE_TELEMETRY` を外しておく必要がある (settings.json から削除済み。詳細はメモリ `claude-code-channels-disable-telemetry-blocks-flag`)
- 恒久化: 根本的には upstream (`anthropics/claude-plugins-official` の `external_plugins/discord/server.ts`) に PR を出すのが確実

---

## パッチ A: 入力中(typing)表示の継続

### 背景・目的

Discord の typing indicator (「入力中...」) は `sendTyping()` 呼び出しから約10秒で自動的に消える。
plugin 標準では inbound 受信時に1回だけ `sendTyping()` を呼ぶため、Claude の返信生成が10秒を超えると
途中で表示が消える。返信完了まで継続表示するよう、チャンネル毎のタイマーで定期再送する。

### パラメータ

| 定数 | 値 | 意味 |
| --- | --- | --- |
| `TYPING_RESEND_MS` | `8_000` (8秒) | 再送間隔。Discord の ~10秒切れより短くする必要がある |
| `TYPING_MAX_MS` | `10 * 60_000` (10分) | 安全弁。reply が来なくてもこの時間で停止し、無限ループを防ぐ |

### 注意すべきポイント

- **無条件停止方式**: reply 時に `clearTyping` を呼んで typing を即停止する。`startTyping` は重複 inbound に対し `pending++` するが、reply の経路では `stopTyping` (`pending--`) を使わず `clearTyping` で一括停止する。これにより interrupt 由来の永続 pending(reply されないターンがあると pending が減らず安全弁 10 分まで残る)を根絶し「タスク完了後も入力中が消えない」事象を解消する。トレードオフ: ユーザー連続入力中に最初の reply で typing がいったん消え、2 つ目以降の inbound の処理は typing 無しで進む(一般的な bot 体験で違和感は少ない)。`stopTyping` 関数自体は ref-counting の選択肢として残してあり、安全弁 10 分のフォールバックも維持。

### 関連

- メモリ: `discord-plugin-typing-continuation-patch` (本書を参照している)

---

## パッチ B: 複数セッション自動ルーティング

### 背景・目的

複数の Claude Code セッションが同一 Discord bot に接続すると、全セッションが全メッセージを受信して
重複処理が発生する。各セッションが起動ディレクトリ名(プロジェクト名)に対応する担当チャンネルのみを
処理するよう gate で振り分ける。DM は `cc-discord` セッション固定で1セッションに集約する。

構成要素は 3 つ: (1) `CLAUDE_PROJECT_DIR` から正規化した `OWNER_NAME` 等のルーティング変数、
(2) ready 時と 60 秒毎の定期再解決で担当チャンネルを決め routes ファイルへ書く `resolveOwnedChannel`、
(3) gate 内のルーティングゲート。

### 注意すべきポイント

- **fail closed**: `CLAUDE_PROJECT_DIR` が設定されているのに正規化名が空 (日本語のみのディレクトリ名等) の場合は全 inbound を drop する (全件処理への退行を防ぐ)。`CLAUDE_PROJECT_DIR` 未設定 (単独セッション運用等) ではゲートをスキップし全メッセージを処理する後方互換
- **担当チャンネル解決は許可済み guild テキストチャンネル限定**: 同名のカテゴリ/ボイス/フォーラム/スレッドを誤って担当にしない。さらに access.json で許可済み (groups 登録済み) に限定する。進捗送信 (watch/notify) は gate を通らず REST で直接投稿するため、ここで許可リストを強制しないと同名の未許可チャンネルへセッション内容が流出しうる
- **定期再解決 (60 秒毎)**: /discord:access による許可追加やチャンネル改名を再起動なしで反映する。解決先が変わったら古い progress-thread を破棄する (notify は progress-thread を route より先に読むため、残すと旧スレッドへ進捗が流れ続ける)。一致チャンネルが無くなった場合は stale な route ファイルも削除する
- **routes ファイル**: `~/.claude/channels/discord/routes/<OWNER_NAME>` に担当チャンネル ID を書く (hook/監視が読む)。ディレクトリ 0o700、ファイル 0o600。チャンネル ID が平文で書かれるため他ユーザーから読まれないよう制限する
- **DM は cc-discord セッション固定**: 他セッションは allowlist 済みでも drop し、DM を1セッションに集約する (重複防止)。guild のスレッドは親チャンネル ID で担当判定する

### 関連

- メモリ: `cc-discord-channel-enhancements-plan` (本改変の設計計画を参照している)
- `plugin/src/normalize.ts` (同じ正規化ロジックの cc-discord 側実装)

---

## パッチ C: 進捗ストリーミング用 per-inbound スレッド作成

### 背景・目的

途中経過 (tool 通知、thinking、text) を親チャンネルに直接流すと会話本筋に埋もれる。
inbound メッセージ毎に新規スレッドを立てて、Claude の途中経過はそのスレッド内に蓄積する。
最終的な `reply` ツール経由の返信は引き続き親チャンネル (または DM) に投稿される。

### 接続点 (cc-discord 側)

`plugin/src/notify.ts` の `progressChannelId()` が `~/.claude/channels/discord/progress-thread/<owner>` を読み、`postMessage` の宛先に使う。

- スレッド ID があれば → スレッドに投稿 (途中経過)
- DM の場合は DM channel ID → DM に直接投稿
- ファイル無 or 空 → `channelId()` (親チャンネル) にフォールバック

`watch.ts` (transcript 監視) は text と tool_use の両方を抽出し `notify` 経由で投稿するため、自動的に新しい宛先に切り替わる。`reply` ツールは MCP 経由で `chat_id` を直接受けるため本パッチの影響なし。

### パラメータ

| 定数 | 値 | 意味 |
| --- | --- | --- |
| `autoArchiveDuration` | `60` (1 時間) | Discord のスレッド自動アーカイブ時間。最短値を採用し放置スレッドが速やかに畳まれるようにする |
| スレッド名 | `[MM/DD HH:MM] <本文>` | 日時プレフィックス + inbound 本文。本文は空白正規化し 80 字超は 79 字 + … (コードポイント単位)。空は progress。プレフィックス込みで Discord 上限 100 字以内。`plugin/src/summarize.ts` の `threadName()` と同じロジックのインライン化 |

### 注意すべきポイント

- **bot 投稿 @silent アンカー + public スレッド方式**: 旧実装は (a) `msg.startThread` で inbound 自体をアンカー → アンカー作者であるユーザーが毎回スレッド参加者となり per-thread のフォロー通知が付く副作用、(b) `threads.create({ type: PrivateThread })` → フォローは消えるが閲覧にスレッド管理権限が要りオーナー以外辛い、という 2 案を経た。最終的に親チャンネルに bot 自身が `SUPPRESS_NOTIFICATIONS` (ビット 12 = 4096) 付きでゼロ幅スペース (U+200B) 1 文字のアンカーを投稿し、そのアンカーから `startThread` で public スレッドを立てる方式に到達。利点: アンカー作者が bot なのでユーザーはスレッド参加者にならずフォロー通知が付かない / public なので所有者はクリックで閲覧できる (管理権限不要) / アンカー付き作成なので親チャンネルの type 18 (started a thread) システム行は出ない / アンカー自身も `@silent` で push が飛ばない。アンカー本文は親チャンネルでの存在感を最小化するため視覚的に空(ZWSP 1 文字)とする。ASCII space と NBSP (U+00A0) は Discord 側で trailing trim されるため不可、ZWSP は Format カテゴリで trim 対象外として残る。トレードオフ: 親チャンネルにゼロ幅の bot メッセージが毎回 1 件残る (ほぼ視認不能)。bot は他ユーザーの per-thread 通知レベルを変更する API を公式に持たないため、これが「ユーザー側設定に頼らずに通知を抑止する」唯一の API パターンとなる。なお Discord クライアントは `THREAD_CREATE` gateway イベントに対し独自にプッシュ通知を出す仕様で、bot 側で API レベルにこれを抑止する手段は存在しない(調査済)。完全に消したい場合はチャンネル単位の Notification Override で「Notify me of new threads」を OFF にする必要がある。
- **inbound 毎に新規スレッドを作る** (案 Q)。連続入力中の追加 inbound でも別スレッドが立つため、進捗の流れがメッセージ単位で分かれる。失敗したら catch で親チャンネルにフォールバック。
- **message_id ロックで多重処理を防止** (2026-06-10 追加)。Claude Code はセッション毎に MCP server として server.ts を起動し、`--channels` の有無に関わらず各プロセスが Gateway に接続して messageCreate を受ける。resume / fork-session のバックグラウンド daemon セッションや Claude Desktop のセッションも含め、同名ディレクトリのセッションが N 個あると同じ inbound に対しスレッドが N 個立っていた (2026-06-10 に実際に発生。アンカー 3 連投を確認)。対策として `progress-thread/<OWNER_NAME>.lock-<message_id>` を `flag: 'wx'` (排他作成) で書けた 1 プロセスだけがスレッドを作成する。wx は OS レベルでアトミック (Windows + bun で 5 並行 1 勝を検証済)。EEXIST 以外のエラーは従来どおり続行 (進捗喪失よりも多重を許容)。**ロック敗者は typing を止めて inbound ごと破棄する** (2026-06-12 追加。スレッド作成の抑止だけでは敗者プロセスも inbound を処理し重複返信しうるため、ロックを実質のルーティングゲートとして使う)。60 秒より古いロックは勝者が掃除する (直近の別 inbound の処理中ロックを消さないための猶予)。注意: ロックを知らない旧版コードのプロセスが残っている間は多重が残るため、反映には**全セッションの再起動**が必要。
- **進捗スレッドは owner 単位の単一ストリーム**: progress-thread/<owner> は inbound 毎に上書きされるため、同一プロジェクトで前ターンの進捗が流れている最中に次の inbound が来ると、前ターン残りの進捗は新しいスレッドへ流れ込む。セッション=単一ストリームという意図したトレードオフであり、inbound 単位の厳密な紐付けはしない (2026-06-12 PR レビューで指摘、設計判断として記録)。
- **DM はスレッド作れない** (Discord 仕様)。channel ID をそのまま `progress-thread/<owner>` に書き、notify は DM に直接投稿する。
- **OWNER_NAME 空のセッションは何もしない**。`CLAUDE_PROJECT_DIR` 未設定の単独セッション運用に影響を与えない。
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
コード装飾はメンション ping の防御にならないため、bot の送信経路 (`reply` の `ch.send` と
`edit_message` の `msg.edit`) で `allowedMentions: { parse: [] }` を指定し content 由来の
メンション解決を全面的に無効化する。詳細は `docs/discord-text-formatting.md`。

### 注意すべきポイント

- **`allowedMentions` を指定すると `replied_user` も既定で false になる** (Discord API 仕様)。
  `replyToMode: 'first'` に戻しても引用 reply の相手 ping は発生しなくなるため、
  access.json の `replyToMode: 'off'` (ping 対症療法) は不要になったら戻してよい。
- watch 経由の進捗通知は `plugin/src/notify.ts` 側で同じ対処済み (`allowed_mentions: { parse: [] }`)。
- ペアリング完了通知 (`Paired! ...`) と ZWSP アンカーは固定文字列のため対象外とした。

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

構成要素は 2 つ: (1) `.txt` を読む `replyStatusFooter()` ヘルパー (10 分より古い =
セッション非アクティブなら付けない)、(2) reply のチャンク化で本文だけを chunk し
footer は末尾チャンクに収まるなら結合、収まらなければ独立チャンクとして送る処理
(チャンカーが footer のコードフェンスを分断しないため)。

### 注意すべきポイント

- **settings.json 側の前提**: `statusLine.command` が tee でラップされていること。
  例 (`<repo>` は本リポジトリの clone 先。statusline スクリプト部分は自身の設定に置き換える):
  `bun <repo>/plugin/src/statusline-tee.ts uv run ~/.claude/scripts/statusline.py --icons=nerd`
  tee を外すと .txt が更新されなくなり、10分で footer は自然消滅する。
- **owner 単位の last-writer-wins**: 同一プロジェクトでセッションが並走すると最後に statusline を
  描画したセッションの値になる。reply する瞬間は自セッションがアクティブなため実用上は一致する。
- statusline はアクティブなインタラクティブセッションでしか描画されない。headless 等では footer なし。

### 関連

- `plugin/src/status.ts` (整形ロジック本体、`plugin/test/status.test.ts` でテスト)
- `plugin/src/statusline-tee.ts` (statusline JSON の捕捉と .txt 生成)

---

## パッチ F: 滞留 progress thread の定期クリーンアップ

### 背景・目的

パッチ C で進捗用スレッドを `autoArchiveDuration: 60` で作っているが、Discord 側の auto-archive が API レベルで発火しないケースが実測された (`archived=false` のまま日数単位で滞留)。cc-discord 側で定期的に「stale な (= 一定時間 inactive な) progress thread」を一括 `setArchived(true)` する。

### 接続点

- `ready` ハンドラで `archiveStaleProgressThreads()` を即時 1 回実行 + 5 分毎の `setInterval` を起動 (`unref` 済み)。
- scan 対象は `ownedChannelId` 配下の active threads に限定する。`OWNER_NAME` 未設定・`ROUTING_BROKEN`・`ownedChannelId === null` のいずれかなら scan 自体を skip する。同 bot トークンで複数 OWNER_NAME セッションが並走する環境でも、各自が自分の channel しか触らないため guild-wide な `fetchActiveThreads()` 重複と rate limit リスクが消える。
- handleInbound と reply 経路では archive を行わない。並行 inbound や watch の in-flight POST と競合させないため、active なスレッドには触らない設計にしている。

`archiveStaleProgressThreads()` は `client.channels.get(ownedChannelId).threads.fetchActive()` で self channel 配下の active threads を取得し、以下の AND 条件で絞ったものだけ `setArchived(true)` する:

- `archived === false` (現在 active)
- `ownerId === client.user.id` (bot 自身が作成)
- 名前が `^\[\d{2}/\d{2} \d{2}:\d{2}\]` パターン (cc-discord 生成スレッド)
- `autoArchiveDuration === 60` (cc-discord は 60 固定)
- 最終メッセージ (snowflake から派生) または `createdTimestamp` から 60 分以上経過

### 注意すべきポイント

- **active なスレッドには絶対に触らない**: 60 分以上 inactive を条件にしているため、進行中の会話や watch の遅延 POST が来うる時間帯のスレッドは対象外。これで並行 inbound レース・auto-unarchive レース・スレッド再利用レースすべて発生し得ない。
- **handleInbound 内 archive 経路は廃止**: 旧設計は inbound 直前と reply 完了時に `archiveProgressThread()` を呼んでいたが、reply は MCP ツール呼び出し時点で並走 inbound の上書きと完全紐付けできず、handleInbound 側も `notify.ts` の遅延 POST と組み合わせると `setTimeout` 遅延・write-lock 等を積んでもレースを完全消去できなかったため全廃した。
- **archive 対象判定の厳密さ**: scope を self owned channel に絞っても、判定条件を緩めると同 channel 内の他用途スレッドを誤閉鎖しうる。5 条件 AND を維持する。
- **archive 時に ptFile を clear する**: `progress-thread/<OWNER_NAME>` が archive 対象スレッドの ID を指したままだと、`notify.ts` の watcher が次の send で archived thread に投稿し auto-unarchive を招く。`setArchived(true)` 直前にファイル内容を読み、一致すれば削除する。
- **archive タイミング**: 単発で完結した会話は最大 60 分 + 5 分 = 65 分でアーカイブされる。Discord 標準の 60 分とほぼ同等で、運用上の体感差はない。
- **過去の滞留スレッド**: 起動直後の即時実行で owned channel 配下が対象になる。他 channel の滞留は対象外 (誤対象リスクを取らない方針)。

### 関連

- メモリ: `cc-discord-channel-enhancements-plan` (本リポジトリの全体設計)
