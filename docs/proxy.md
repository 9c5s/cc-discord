# cc-discord 透過プロキシ

## 概要

`cc-discord` は、公式の discord channel plugin (`discord@claude-plugins-official`) を無改変のまま拡張するプラグインである。
Claude Code と公式 server の間に proxy を挟み、stdio の JSON-RPC を行単位で中継しながら、差し込みたい振る舞いを MCP 境界と Discord REST で実現する。

以前はキャッシュ上の `server.ts` にパッチを当てていたが、`/plugin update` のたびに再適用が必要で、上流の改修で適用できなくなる問題があった。
proxy 方式では公式のファイルに触れないため、更新はバージョン対応表の追随だけで済む。

proxy が担う範囲は次のとおりである。

- 担当チャンネル以外の inbound を破棄する (複数セッションの重複処理を防ぐ)
- inbound ごとに進捗用スレッドを作り、途中経過をそこへ転送する
- 返信が返るまで入力中の表示を継続する
- `reply` と `edit_message` を take over し、メンション解決の無効化と footer の付与を行う
- 送信系ツールの宛先を担当チャンネルに限る
- 滞留した進捗スレッドを閉じる

## 構成

```
cc-discord/                       (リポジトリ = marketplace)
  .claude-plugin/marketplace.json
  plugin/
    .claude-plugin/plugin.json
    .mcp.json                     discord サーバーとして proxy.ts を起動する
    hooks/hooks.json              SessionStart のみ
    skills/access, skills/configure  公式のコピー (呼び名は /cc-discord:*)
    src/
      proxy.ts                    中継と配線 (対応版判定 / heartbeat / 周期処理 / 終了処理)
      relay.ts                    行単位の読み取りと drain 待ちの writer
      official.ts                 公式 server の起動元解決と対応版判定 (--check)
      discord-api.ts              REST 呼び出し
      access.ts                   access.json の読み取りと outbound gate
      routing.ts                  担当名の解決 / 担当チャンネルの決定関数 / inbound の判定
      activation.ts               現行 activation のポインタと heartbeat
      owner-resolver.ts           担当チャンネル解決の周期処理
      inbound.ts                  ロック / typing / 進捗スレッドの作成
      progress-target.ts          進捗の宛先ファイル
      progress-sender.ts          進捗の送信 (activation 確認 + outbound gate)
      reply.ts                    reply / edit_message の take over
      footer.ts                   reply 末尾の footer 組み立て
      stale-threads.ts            滞留スレッドの archive
      session-start.ts            SessionStart hook
      watch.ts                    transcript の監視 (watcher 本体)
      ids.ts / normalize.ts / routes.ts / status.ts / summarize.ts / usage.ts
      watch-launch.ts / watch-stop.ts / statusline-tee.ts  移行期間の互換 shim
```

判定ロジックは純粋関数として切り出し、REST 呼び出しと配線から分けている。
これにより、担当の決定や outbound gate をプロセスを起動せずに検証できる。

## 起動と接続

channels は研究プレビュー中で、`--channels` に渡せるのは Anthropic が維持する既定の allowlist に載ったプラグインか、managed settings の `allowedChannelPlugins` で承認したプラグインだけである。
cc-discord は第三者プラグインなので後者で承認する。
Windows では `HKCU\SOFTWARE\Policies\ClaudeCode` の `Settings` (REG_SZ) に JSON 全体を置く。
このキーは HKLM とファイル版の managed settings が無いときだけ読まれるため、管理者権限が要らない。

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "marketplace": "cc-discord", "plugin": "cc-discord" }
  ]
}
```

`allowedChannelPlugins` は既定の allowlist を置き換えるため、公式の channel プラグインも使うならここに併記する。
managed settings を 1 つでも置くと channels の既定が無効に変わるので、`channelsEnabled` は必ず `true` を明示する。

承認せずに `--dangerously-load-development-channels plugin:cc-discord@cc-discord` で起動することもできるが、対話セッションでは起動のたびに確認ダイアログが出る (承諾の永続化は無い)。

シェルの起動関数は、起動ごとに `CC_DISCORD_RUN_ID` (暗号学的乱数 128 ビットの 16 進 32 文字) を生成し、子プロセスの実行中だけ環境に置く。
PowerShell では次の形にする。
既存値を退避して `finally` で復元するため、連続した 2 回の起動で異なる値になり、子の終了後に親シェルへ残らない。

```powershell
function claude {
  $prev = $env:CC_DISCORD_RUN_ID
  $bytes = [byte[]]::new(16)
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  $env:CC_DISCORD_RUN_ID = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
  try {
    & "~/.local/bin/claude.exe" --dangerously-skip-permissions --channels plugin:cc-discord@cc-discord @args
  } finally {
    if ($null -eq $prev) { Remove-Item Env:CC_DISCORD_RUN_ID -ErrorAction SilentlyContinue } else { $env:CC_DISCORD_RUN_ID = $prev }
  }
}
```

`run_id` は起動インスタンスの識別子である。
proxy は自分の親プロセス (Claude Code) の PID と組み合わせて、どの起動のどの activation に属するかを判定する。
`CC_DISCORD_RUN_ID` を持たないプロセスでは進捗転送だけが無効になり、配送と reply は動く。

### 公式バージョンの固定

take over は公式 0.0.4 の `reply` / `edit_message` の意味論を移植したものである。
上流が変わると、`tools/list` が新しい schema を公開しながら proxy が古い意味で処理する不一致が起きる。
これを防ぐため、`official.ts` に対応表を持ち、起動する `server.ts` の SHA-256 が表に無ければ子プロセスを起動せずに終了コード 1 で終わる。
Claude Code はこれを接続失敗として扱い、そのセッションは Discord 無しになる。

対応外のまま中継だけ続ける passthrough は採らない。
passthrough では全セッションがルーティングもロックも持たない公式 server になり、重複処理と担当外への配送が再発するためである。

`bun plugin/src/official.ts --check` は、インストール先、実行ファイルの hash、素のファイル (`server.ts.orig` があればそれ) の hash、対応表との一致を表示する。
移行手順とアップデート手順で使う。

### 検証用の担当上書き

環境変数 `CC_DISCORD_PROJECT_DIR` を設定すると、担当名を `CLAUDE_PROJECT_DIR` ではなくその値から決める。
proxy、hook、watcher はすべて同じ解決関数を使うため、同じセッションの全構成要素が同じ担当名になる。
proxy は子 server にも `CLAUDE_PROJECT_DIR` としてこの値を渡す。

空のディレクトリからセッションを起動し、この変数で別の担当を指すと、同じセッション内で並走する公式 server (担当はディレクトリ名、チャンネル無し) と競合させずに検証できる。

## 各振る舞いの意図

### typing の継続

Discord の入力中表示は、送信から約 10 秒で自動的に消える。
公式は inbound の受信時に 1 回だけ送るため、返信の生成が 10 秒を超えると途中で消える。
proxy はロックを取ったセッションだけが 8 秒ごとに送り直し、返信まで表示を続ける。

停止は `reply` の tools/call を受けた時点で無条件に行う。
ref-count 方式では、中断で返信されないターンがあると残数が減らず、安全弁の 10 分まで表示が消えない。
連続入力の途中で表示がいったん消えるトレードオフはあるが、一般的な bot の挙動として違和感は小さい。

安全弁として 10 分で必ず停止する。

### 担当チャンネルのルーティング

複数の Claude Code セッションが同じ bot に接続すると、公式 server はすべてのセッションで起動して Gateway に接続するため、全セッションが同じメッセージを受け取る。
proxy は、起動ディレクトリ名を正規化した担当名に一致するチャンネルの inbound だけを通す。

担当チャンネルの決定関数は 1 つで、`GuildText` かつ正規化名が担当名に一致し、かつ `access.json` の `groups` に登録済みの候補を全 guild から集める。
0 件なら未解決、2 件以上なら曖昧、1 件ならそれを担当とする。
proxy の担当解決も進捗送信の gate も同じ関数を使うため、両者の結果が食い違わない。

失敗はすべて fail closed にしている。

- 担当ディレクトリはあるのに正規化名が空 (記号だけの名前など) なら、全 inbound を破棄する
- 候補が複数なら、inbound の配送と進捗の送信の両方を止める
- チャンネルの取得に失敗したとき、取得結果の id が要求と違うとき、識別子の形式が不正なときも破棄する
- メッセージの生成から 1 時間を超えた通知と、5 分より未来に見える通知も破棄する。配送の直前にも同じ判定をやり直す
- inbound のロックを取れなかったときは、EEXIST もそれ以外の失敗も破棄する

担当ディレクトリが未設定のセッションでは、ルーティング自体を行わず全通知を素通しする (単独運用の後方互換)。
DM の担当は `cc-discord` という担当名のセッションだけで、guild の担当解決には依存しない。

最初の担当解決は子の起動を待たずに始め、起動直後の inbound はその完了を待ってから判定する。
待たずに判定すると、解決が終わる前に届いた guild の通知が未解決として破棄される。
通知は再送されないため、破棄した分はそのセッションに届かないままになる。
解決はチャンネル実体の取得と並行に進むため、実際に待つのは REST が長引いたときだけである。

担当は 60 秒ごとに解決し直す。
チャンネルの改名や access の変更を再起動なしで反映するためである。

guild やチャンネルの一覧を取得できなかった周期は、直前の担当を据え置く。
ただし据え置きは最後に解決しきれた時刻から 5 分までで、そこを超えたら担当を手放して inbound の配送を止める。
REST の一時的な失敗で配送を落とさず、障害が長引くときは古い担当のまま配送し続けない、という切り分けである。

この猶予は proxy の中だけの仕組みである。
watcher は送信のたびに自分で担当を解決し直すため、一覧の取得に失敗した時点で進捗を送らない。
進捗は送れなくても欠落するだけで害がなく、猶予の状態を別プロセスと共有する複雑さに見合わないためである。

担当が別のチャンネルへ移ったときと担当を手放したときは、route と進捗の宛先を消す。
消すのは自分の run の宛先だけで、同じ担当で並走する他セッションの宛先には触れない。
他セッションも自分の resolver で同じ REST の結果を見て同じ判断に至るため、こちらから消すと、健全なセッションの進捗を次の inbound まで止めるだけになる。
本体 (`progress-thread/<owner>`) は run を区別できないので、担当を失った時点で消す (旧 reader を止める側に寄せる)。

### 進捗スレッド

途中経過を親チャンネルへ直接流すと会話の本筋に埋もれるため、inbound ごとにスレッドを立てて、そこへ転送する。
`reply` による返信は従来どおり親チャンネル (または DM) へ送る。

スレッドの作り方は、bot 自身がゼロ幅スペース 1 文字を通知抑止フラグつきで投稿し、そのメッセージから public スレッドを立てる方式である。
inbound 自体をアンカーにすると、作者であるユーザーがスレッドの参加者になりフォロー通知が付く。
private スレッドにすると、閲覧に管理権限が要る。
bot 投稿をアンカーにすると、どちらも避けられ、親チャンネルに「スレッドを開始しました」のシステム行も出ない。
アンカーはゼロ幅スペースにしている。
半角空白と NBSP は Discord 側で除去されるが、ゼロ幅スペースは残るためである。

スレッドの自動 archive は 60 分、名前は `[MM/DD HH:MM] <本文>` で、本文は 80 字を超えたら 79 字に切る。

同じ inbound を複数のセッションが処理しないよう、`progress-thread/<owner>.lock-<message_id>` を排他作成し、取れたプロセスだけがスレッドを作って通知を転送する。
取れなかったプロセスは通知ごと破棄する。
スレッド作成の抑止だけでは、敗者のセッションも inbound を処理して重複返信しうるためである。

DM にはスレッドを作れないため、DM チャンネル自身を宛先にする。
スレッド内の inbound は、そのスレッドをそのまま宛先にする。

### 担当外への送信の遮断

公式の `access.json` は、ペアリング済みのチャンネルをすべて許可する単一の allowlist である。
これだけを条件にすると、あるプロジェクトのセッションから、同じ bot に登録された別プロジェクトのチャンネルへ返信も履歴取得もできてしまい、担当の分離が inbound 側にしか効かない。
Discord のメッセージ本文は外部入力なので、別チャンネルの id を指す指示が紛れ込む経路も現実に存在する。

そこで proxy は、宛先を引数に持つ 5 つのツールすべてを担当で絞る。

| ツール | 引数 | 経路 |
| --- | --- | --- |
| `reply` | `chat_id` | take over の中で判定する |
| `edit_message` | `chat_id` | take over の中で判定する |
| `react` | `chat_id` | 子へ渡す前に判定する |
| `download_attachment` | `chat_id` | 子へ渡す前に判定する |
| `fetch_messages` | `channel` | 子へ渡す前に判定する |

判定は inbound と同じ決定関数 (`decideOutbound` から `decideDelivery` を呼ぶ) で行う。
allowlist の判定 (`isAllowedTarget`) を通った後に、担当の判定を重ねる形である。
そのため「配送を許す宛先」と「送信できる宛先」が常に一致する。

- 実体を取得できない、id が要求と違う、担当チャンネル (スレッドなら親) と一致しない場合は送らない
- DM は `cc-discord` 担当のセッションだけが送れる (inbound と同じ規則)
- 担当ディレクトリが未設定のセッションでは判定しない (単独運用の後方互換)

take over しないツールを遮断したときは、子へ渡さずに `isError` の応答を proxy が返す。
担当が未解決や曖昧なセッションでは、guild 宛の送信がすべて失敗する。
これは意図した fail closed であり、担当を復旧するまで送信できない。

### メンション解決の無効化

コードブロックやインラインコードの中の `@everyone` や `<@USER_ID>` は、表示上は素のテキストのままでも、Discord API がメッセージ全体から解析して通知を発生させる。
コードによる装飾は防御にならないため、proxy が送るすべてのメッセージ (reply、edit_message、進捗、アンカー) に `allowed_mentions: { parse: [] }` を付ける。
詳細は `docs/discord-text-formatting.md` に記録している。

`allowed_mentions` を指定すると、引用返信の相手への通知も既定で無効になる。

### reply 末尾の footer

返信の末尾に、ブランチ名、モデル名と effort、コンテキスト使用率、5 時間枠と 7 日枠の使用率をコードブロックで付ける。

以前は statusLine コマンドをラップして statusline の入力 JSON を保存していたが、proxy は同じ値を別の経路から集める。

- ブランチ: 担当ディレクトリの `.git/HEAD` を直接読む
- モデル、effort、コンテキスト使用量: 現行 activation の transcript の末尾から、直前ターンの assistant エントリを逆順に探す
- コンテキストの分母: settings の `model` が `[1m]` で終わるかどうかで 1,000,000 か 200,000 を選ぶ
- 5 時間枠と 7 日枠、モデル別枠: 使用量 API のキャッシュから読む (更新は別プロセスへ逃がす)

現行 activation のポインタが無いか、`run_id` が一致しない場合は、モデル行とコンテキスト使用率を省き、ブランチと使用量だけで作る。
別のセッションや別の起動の値を出さないためである。

footer は本文とは別にチャンク化し、末尾のチャンクに改行 1 つを挟んで収まるなら結合し、収まらなければ独立したチャンクとして送る。
チャンク分割がコードブロックの終端を分断しないようにするためである。

### 滞留スレッドの archive

進捗スレッドは自動 archive を 60 分にして作るが、Discord 側の自動 archive が発火しないまま滞留する事例がある。
proxy は起動直後と 5 分ごとに、担当チャンネル配下の稼働中スレッドを調べ、次の条件をすべて満たすものだけを閉じる。

- 親が担当チャンネルである
- bot 自身が作成した
- 名前が `[MM/DD HH:MM]` で始まる
- 自動 archive が 60 分である
- 最終メッセージまたは作成から 12 時間以上経過している
- そのスレッドを指す有効な宛先が残っていない

条件を緩めると、同じチャンネル内の他用途のスレッドを誤って閉じうるため、6 条件の AND を維持する。
12 時間という閾値は、進行中の会話や遅れて届く進捗の投稿と競合しないための余裕である。

最後の条件は、2 つの 12 時間が別の起点を持つために要る。
スレッドの無活動は Discord 側の最終活動時刻から数えるが、宛先の有効期間はスレッドを作った直後に記録する `written_at` から数える。
`written_at` のほうが必ず後になるので、閉じる条件を満たした時点でも宛先がわずかに有効なままのことがある。
宛先の有効期間を直接確かめて、有効なものが残っている間は閉じない。

閉じる前に、そのスレッドを指す宛先だけを取り除く。
宛先を残したままにすると、watcher が閉じたスレッドへ投稿して開き直してしまう。
宛先ファイルは id が一致するものだけ、本体は内容が一致するときだけ削除し、片方の一致を理由に他方を消さない。
削除に失敗した宛先が 1 つでもあれば、そのスレッドは閉じずに次の周期へ回す。

## 進捗転送の仕組み

進捗の転送は **activation** に紐付ける。
activation とは、1 回の SessionStart (`startup` / `resume` / `clear` / `fork`) で始まる期間で、hook が生成する `activation_id` で識別する。
compaction は同じ作業の継続なので activation を変えない。

- SessionStart hook が、Claude Code の PID ごとに「現行 activation のポインタ」を書く
- proxy は inbound のたびにポインタを読み、宛先ファイル (`.meta`) に activation を刻む
- watcher は自分の activation が現行である間だけ投稿する

セッションの生存は、proxy が 5 秒ごとに書く heartbeat の鮮度 (15 秒) で判定する。
PID の生存確認は PID の再利用を見分けられないため、安全境界には使わない。
heartbeat のパスには `run_id` を含めるため、PID を再利用した別の起動の proxy と同じファイルを操作しない。

watcher は次のように自律終了する。

- 起動直後は最初の有効な heartbeat を最大 30 秒待つ (この間は投稿しない)
- 確認後は毎秒と各投稿の直前に、heartbeat とポインタを確認する
- ポインタが別の activation を指していたら、送信キューを破棄して終了する
- heartbeat が失効しただけなら待機へ戻り、そこから 30 秒待って戻らなければ終了する

heartbeat の失効で即座に終了しないのは、書き直しが判定より遅れる経路があるためである。
watcher の判定は毎秒、proxy の書き込みは 5 秒ごとなので、サスペンドからの復帰直後は watcher の判定が先に動く。
MCP だけが再起動される経路 (`/reload-plugins` など) でも、新しい proxy が書き直すまでの数秒は失効して見える。
終了した watcher は同じ activation では再起動しないため、どちらの場合も次の SessionStart まで進捗が止まる。

これにより、Claude Code の終了やクラッシュ (heartbeat が止まる)、PID の再利用 (heartbeat の run_id が違う)、`/clear` や `/resume` による activation の切り替え (ポインタが変わる) のいずれでも、古い watcher は残らない。
停止のための hook も pid ファイルも持たない。

進捗の送信は、投稿のたびに次の順で確認する。

1. activation の事前確認 (heartbeat とポインタ)
2. outbound gate (宛先の実体を取得し、guild は担当の決定関数と、DM は allowFrom と照合する)
3. activation の最終再確認
4. 再確認の直後に、待機を挟まず投稿する

`retry_after` を待った後の再送は新しい送信試行として扱い、1 からやり直す。
待機の間に activation や allowlist が変わった場合に、古い判定のまま投稿しないためである。

判定は宛先ファイルの自己申告値や route ファイルではなく、API から取得した実体で行う。
そのため、route ファイルの更新や削除に失敗していても、担当外への送信は止まる。

## ファイル契約 (state dir)

state dir の既定は `~/.claude/channels/discord` で、`DISCORD_STATE_DIR` があればそれを使う。
相対パスが渡された場合は、子を起動する前に絶対パスへ直す。
子は `--cwd` で公式プラグインのディレクトリへ移ってから動くため、相対のままだと proxy と子が別の場所を state dir とみなす。
新しく書くファイルは、PID 付きの一時ファイルへ書いてから rename する。
ファイル名に埋める識別子は、形式を検証し、解決後のパスが対象ディレクトリの直下であることを確認してから読み書きする。

| パス | 内容 |
| --- | --- |
| `routes/<owner>` | 担当チャンネル id。移行期間の旧 reader のために書き続ける |
| `progress-thread/<owner>` | 進捗の宛先 id。同じく旧 reader のために書く |
| `progress-thread/<owner>.<activation_id>.meta` | 進捗の宛先 (JSON)。新しい reader はこれだけを読む |
| `progress-thread/<owner>.lock-<message_id>` | inbound の排他ロック。担当解決の周期で 12 時間より古いものを回収する |
| `session/by-pid/<claude_pid>.json` | 現行 activation のポインタ |
| `session/by-pid/<claude_pid>.<run_id>.heartbeat` | proxy の heartbeat |
| `logs/proxy-<owner>.log` | proxy のログ |
| `model-usage.json` | 使用量 API のキャッシュ |

宛先ファイルは activation 単位なので、同じ session_id を別のプロセスから同時に resume しても互いを上書きしない。

proxy の終了処理では heartbeat と自分の run の宛先を消すが、ポインタは残す。
MCP だけが再起動される経路では SessionStart が発火せず、誰もポインタを作り直さないためである。
消すと、以後の inbound はすべて進捗の宛先を持てないまま処理される。
残したポインタは次の SessionStart で置き換わり、それも無ければ 7 日後の掃除で消える。
その間に古いポインタが誤って使われることはない。
`run_id` が一致しなければ現行 activation として採用せず、heartbeat が無ければ watcher も投稿しないためである。

宛先の有効期間の終端は 5 つである。

1. 同じ activation の次の inbound による上書き
2. activation の切り替え (新しい SessionStart)
3. 担当の移動と喪失による自分の run の宛先の削除
4. proxy の終了処理での自分の run の宛先の削除
5. 書き込みから 12 時間

返信では終わらせない。
Claude は途中経過を返信してから作業を続けることが多く、返信の後の作業こそスレッドで確認したいためである。

## レビューでの判断記録

外部レビューで指摘され、検証のうえで反映しなかった事項を残す。
同じ指摘を繰り返さないための記録である。

### permission relay は公式のまま素通しする

`notifications/claude/channel/permission_request` を proxy で破棄する案があった。
公式 0.0.4 はこの通知を受けると `access.allowFrom` の全ユーザーへ DM でボタンを送り、返ってきた操作を Claude Code へ中継する。
公式の実装には「single-user mode for official plugins。`allowFrom` は明示的なペアリングを通った利用者だけである」という前提が明記されている。

proxy はこの前提を覆す立場になく、破棄すると公式機能を一方的に殺すことになるため素通しする。
`allowFrom` に複数の利用者を登録した場合、権限要求の内容が全員に見え、誰でも応答できる点は公式の仕様のままである。
ボタンの操作は Gateway 経由で全セッションの公式 server に届くが、`request_id` が一致しないセッションの応答は Claude Code 側で無視される。

### inbound ロックの回収は年齢だけで判定する

当初は `progress-thread/<owner>.lock-<message_id>` を 60 秒で回収していた。
「ロックの取得は通知を受け取った瞬間なので、回収が処理に追いつくことはない」と考えていたが、これは誤りである。
通知の処理は 1 プロセスの中で直列に並ぶため、直前の通知の REST が長引くと、次の通知はキューで待たされてからロックを取る。
その待ちの間に別のプロセスが同じ inbound を処理し、さらに別の通知の処理でロックを回収すると、待たされていたプロセスがロックを取り直して二重に返信しうる。

対策として、処理済みの `message_id` を別に記録する仕組みは持たず、回収までの時間を 12 時間に延ばした。
ロックファイル自体が 12 時間残ることで、処理済みの印を兼ねる。
回収は異常終了で残ったファイルの掃除だけを狙うものであり、処理の完了を保証する時間ではない。
同じ `message_id` の inbound が 12 時間後に再び届くことは事実上ないため、回収を遅らせても取りこぼしは起きない。

ただし、時間だけを根拠にすると「12 時間を超えて待たされた通知」を排除できない。
そこで inbound 側にも上限を設けた。

- `message_id` の生成から 1 時間を超えた通知は配送しない (`INBOUND_MAX_AGE_MS`)
- 5 分より未来に見える通知も配送しない (`INBOUND_MAX_SKEW_MS`)。上限が無いと、時計が大きく遅れた環境で古い通知が新しく見える
- 判定は 2 回行う。実体を取る前と、配送の直前である
  - 実体の取得、スレッドの作成、activation の解決はいずれも待ちを含み、その間に鮮度が切れることがある
  - 配送の直前の判定で落とす場合は、その通知のために始めた typing も止める
  - 宛先の書き込みは 2 回目の判定を通した後に、配送と続けて行う。配送されない通知の宛先を watcher に見せないためである

ロックは作成から 12 時間残り、通知は生成から 1 時間で受け付けなくなる。
ロックの作成は必ずメッセージの生成より後なので、回収された後にその通知が処理されることはない。
2 回目の判定と配送の間には待ちが無いため、判定を通した通知だけが配送される。
古い通知をそもそも配送しないのは、長く止まっていたプロセスが再開したときの挙動としても正しい。

### 宛先の読み取り失敗と不在を区別しない

`listTargets` は列挙や読み取りの失敗を空配列として返すため、archive 側は「宛先が無い」と「宛先を確認できない」を区別できない。
一時的な読み取り障害の最中に archive すると、まだ有効な宛先を残したままスレッドを閉じうる、という指摘があった。

区別のための厳格な読み取り API は追加しない。
このとき起こるのは watcher の投稿によるスレッドの再オープンだけで、宛先が失効すれば次の 5 分周期で閉じ直される。
一時的な I/O 障害という稀な条件のために、宛先の読み取り経路を二重に持つ複雑さは見合わない。

### guild 一覧のページングは行わない

`GET /users/@me/guilds` は 1 回の呼び出しで最大 200 件しか返さない。
201 件目以降の guild にある担当チャンネルは解決できないが、その場合は未解決として配送も送信も止まる (fail closed)。
個人利用の bot で 200 guild を超える状況は想定しないため、ページングは実装しない。

### compact では watcher を張り替えない

`compact` の SessionStart は activation を維持するため watcher を起こし直さない。
watcher は起動時に渡された transcript のパスを持ち続けるので、compaction が別のパスを渡すと古いファイルを見続ける、という指摘があった。

Claude Code の transcript は `<projects>/<プロジェクトディレクトリ>/<session_id>.jsonl` に置かれる。
稼働中の 8 セッションのポインタを実測したところ、`transcript_path` の末尾が `session_id` でないものは無かった。
activation を維持する条件は「`compact` かつ `run_id` と `session_id` の一致」なので、パスが変わるなら `session_id` も変わり、その場合は新しい activation として watcher が起動し直される。
compaction は同じプロセスの中で起きるため、起動ディレクトリも変わらない。

パスが変わりうるのは `resume` と `fork` だが、どちらも activation を維持しないため張り替えの対象にならない。

## 既知の制限

- ローカルの時計が 1 時間以上ずれていると、inbound の鮮度判定によって通知が配送されない。
  ログに `TOO_OLD` (時計が進んでいる) か `TOO_NEW` (遅れている) が並ぶので、滞留との区別はそこで付ける。
- 担当が未解決または曖昧なセッションでは、guild 宛の送信系ツールがすべて失敗する (意図した fail closed)。
- 429 の待ち時間が長い場合、REST 呼び出しは待たずに失敗を返す (自動再送は 5 秒まで、進捗の送信は 10 秒まで)。
  Discord は `retry_after` を尊重するよう求めており、短く丸めた再送は無効リクエストとして数えられる。
- 公式 server が持つ「bot への返信をメンションとみなす」短絡は、proxy が送ったメッセージでは更新されない。
  公式は参照先の取得にフォールバックするが、参照先が削除済みか履歴の権限が無い場合は失敗する。
  メンションを必須にしているチャンネルでのみ影響する。
- 担当外のセッションの公式 server が行う入力中表示 1 回と、リアクションによる受領通知、ペアリングの応答は、proxy 層では止められない。
- `--model` の CLI 指定は proxy から読めないため、その場合のコンテキスト使用率の分母は settings 由来のままになる。
- 5 時間枠と 7 日枠の値はキャッシュ経由で、通常は 60 秒以内、更新に失敗し続けた場合は最大 15 分の遅れがある。
- 上流の更新 (自動更新を含む) の直後は、対応表を更新するまで新しいセッションが Discord 無しになる。
- inbound の後にそのセッションで行ったローカルの作業は、次の inbound、activation の切り替え、proxy の終了、12 時間のいずれかまで、同じスレッドへ転送される (意図した挙動)。
- watcher は heartbeat の失効を確かめてから待機へ戻り、そこから 30 秒で終了するため、Claude Code の終了やクラッシュの後、最長 45 秒は生存する。
  その間に transcript は書かれないため投稿は起きない。
- watcher がクラッシュや一時的な読み取り失敗で終了した場合、同じ activation では再起動しない (次の SessionStart まで進捗の転送が無い)。
- `CC_DISCORD_RUN_ID` を設定せずに起動したプロセス、hook に `CLAUDE_PID` が渡らない環境、MCP サーバーが Claude Code の直接の子として起動されない環境では、進捗の転送が無効になる。
- SessionStart hook が実行されなかった場合、または旧ポインタの削除と新ポインタの書き込みの両方に失敗した場合は、同じ session_id を再び resume したときに、同じセッションの進捗が古いスレッドへ続く。
  宛先は同じユーザーの同じ担当チャンネル内なので、担当外や他のユーザーへは届かない。
- 担当名に一致する `GuildText` が複数登録されていると、そのプロジェクトの guild への配送と進捗の転送が止まる (同名チャンネルを整理するまで)。
- `DISCORD_ACCESS_MODE=static` のとき、`access.json` は proxy と watcher がそれぞれ起動時に読むため、両者の内容が食い違うことがある。

## 移行手順

グローバルの hook の symlink は作業ツリーを直接指すため、実装は別の git worktree で行う。
本リリースを作業ツリーへ反映する時点から検証を終えるまで、一般の新しいセッションを開始しない (例外は検証用のセッション 1 件だけ)。
稼働中のセッションはメモリ上の旧実装で動き続けるため影響を受けない。
同じ担当で旧セッションと新セッションを並走させない。

0. 本リリースを main にマージし、作業ツリーを更新する。
   この時点で、グローバルの `watch-launch.ts` は何もしない shim、`statusline-tee.ts` はパススルーのみ、`watch-stop.ts` は旧 watcher の停止だけの shim に切り替わる。
1. marketplace を登録し、`cc-discord` を user scope でインストールする。
2. `discord@claude-plugins-official` を無効化する (以後、新しいセッションでは公式 server が起動しない)。
3. キャッシュの `server.ts` を `server.ts.orig` で復元し、`bun plugin/src/official.ts --check` で実行ファイルの hash が対応表と一致することを確認する。
4. 「起動と接続」の managed settings を置き、シェルの起動関数を同じ節の形に更新する。
   稼働中のシェルは起動時に読んだ関数定義を保持し続けるため、手順 5 以降はシェルを開き直してから起動する。
5. 旧セッションが動いていない担当で検証セッションを 1 つ起動し、確認ダイアログが出ずに channel が登録されること、inbound からスレッド、進捗、返信と footer までの流れ、ポインタと heartbeat と宛先ファイルの生成、watcher が 1 本であること、proxy と hook が同じ `CC_DISCORD_RUN_ID` を観測していることを確認する。
   SessionStart hook は exec form (`command` と `args`) で登録しているため、ポインタが実際に書かれることをもって hook の起動も確認する。
   担当外のチャンネル id を指して `fetch_messages` や `reply` が拒否されること、担当チャンネルでは通ることも、この検証で確かめる。
6. シェルを開き直してから全セッションを再起動する。
   古い関数のまま起動すると `--channels` が無効化済みの公式プラグインを指したままになり、cc-discord が channel として有効にならず inbound が届かない。
   このとき proxy は inbound を受け取ってロックまで取るため、ログに破棄の記録が残らず、症状は Discord に反応しないことだけになる。
   旧セッションの終了時は、グローバルの `watch-stop.ts` shim が旧 watcher を止める。
   再起動後、`watch-<owner>.pid` のプロセスが残っていないことを確認する。
7. グローバルの settings から hooks と statusLine の記述と symlink を削除する。
8. 次のリリースで shim 3 つと本体の書き込みを外し、残っている `progress-thread/<owner>` と `watch-<owner>.pid` を一度だけ掃除して、もう一度全セッションを再起動する。

手順 5 で失敗した場合は、検証セッションを終了し、worktree で修正して手順 0 からやり直す。
旧運用へ全面的に戻す場合は、起動関数を戻し、managed settings を消し、公式プラグインを再び有効化し、キャッシュに旧パッチを再適用し、作業ツリーを前の版に戻し、`cc-discord` を無効化する。
managed settings を残したままだと、既定の allowlist が置き換わったままになり公式の channel プラグインが登録されない。

同じ担当で旧セッションと新セッションが並走すると、旧 server がロックを取った inbound には宛先ファイルが書かれず、新 watcher は投稿しない。
一方で旧 watcher は、ロックを取ったセッションと同じ transcript を監視している保証が無いため、進捗の欠落や別セッションの進捗の混入が起こる。

## アップデート手順

無効化中のプラグインに `claude plugin update` が適用されるかは公式の記述が無いため、実装時に確認して確定する。
適用される場合は次の手順にする。

1. 全セッションを停止し、新規の起動を止めるメンテナンス時間を取る。
2. 公式プラグインを更新し、`bun plugin/src/official.ts --check` で新しい hash を確認する。
3. 上流の差分 (`tools/list` の schema、outbound gate、送信可否の判定、チャンク分割、通知の meta、起動コマンド、skills) を確認し、take over と skills のコピーを追随させる。
4. 対応表に新しい hash を追加し、契約テストを通す。
5. 全セッションを起動する。

適用されない場合は、同じメンテナンス時間内で「有効化 → 更新 → 即無効化」を行い、その間は一切セッションを起動しない。
有効化している間に起動したセッションでは、proxy と未対応の公式 server が並走するためである。

公式 marketplace は既定で自動更新が有効なため、対応表を更新する前に新しい版がディスクに配置されることがある。
その間に起動した新しいセッションは Discord 無しになる (安全側)。
起動拒否のログと `--check` で検知する運用にしている。
