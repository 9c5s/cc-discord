# Discord テキスト装飾仕様の調査記録

進捗通知 (`plugin/src/summarize.ts` / `notify.ts`) が任意のツール引数文字列を Discord に流すにあたり、
Discord 側で装飾として解釈される文字と、その対処を調査した記録 (2026-06-10)。

## 一次ソース

- [Markdown Text 101 (Discord 公式サポート)](https://support.discord.com/hc/en-us/articles/210298617)
- [Message Formatting (Discord developers reference)](https://docs.discord.com/developers/reference)
- [A guide to Markdown on Discord (matthewzring gist)](https://gist.github.com/matthewzring/9f7bbfd102003963f9be7dbcf7d40e51)
- [discord.py #390 (shortcode は bot 送信で変換されない)](https://github.com/Rapptz/discord.py/issues/390)

## マークダウン装飾の一覧

| 記法 | 効果 |
|---|---|
| `*x*` / `_x_` | 斜体 |
| `**x**` | 太字 |
| `__x__` | 下線 |
| `~~x~~` | 取り消し線 |
| `` `x` `` | インラインコード |
| ```` ```x``` ```` | コードブロック (``` 直後に言語名でハイライト、モバイルはハイライト無効) |
| `# x` / `## x` / `### x` | 見出し (行頭のみ) |
| `-# x` | 小さい字 (subtext、行頭のみ) |
| `> x` / `>>> x` | 引用 (行頭のみ、`>>>` は以降全行) |
| `\|\|x\|\|` | スポイラー |
| `- x` / `* x` / `1. x` | リスト (行頭のみ) |
| `[表示](URL)` | マスクリンク |
| `<URL>` | 埋め込み抑止リンク |
| `\` | 次の装飾文字のエスケープ |

## レンダリング時に変換される特殊構文

| 構文 | 効果 |
|---|---|
| `<@USER_ID>` | ユーザーメンション |
| `<#CHANNEL_ID>` | チャンネルメンション |
| `<@&ROLE_ID>` | ロールメンション |
| `@everyone` / `@here` | 全体メンション |
| `<:NAME:ID>` / `<a:NAME:ID>` | カスタム絵文字 (アニメは `a:`) |
| `</NAME:COMMAND_ID>` | slash command リンク |
| `<t:UNIXTIME[:STYLE]>` | タイムスタンプ (R=相対 等) |
| `<id:browse>` 等 | guild ナビゲーション |

## 重要な事実

### `:shortcode:` は bot 送信では絵文字にならない

`:smile:` のようなショートコードの絵文字変換は**クライアントの入力ボックスが送信前に行う**処理であり、
bot が REST API で送った content の `:smile:` はそのままテキスト表示される。
レンダリング時に絵文字へ変換されるのは Unicode 絵文字そのものと `<:NAME:ID>` 形式だけである。
よって `⚙️[discord:reply]` のような `server:tool` 表記の `:` は、コード装飾の外であっても絵文字化しない。

### コード装飾の中ではマークダウンが無効化される

インラインコードとコードブロックの中では `*` `_` `~~` `||` などの装飾、メンション、リンク化は
すべて無効化され、書いたまま表示される。本プラグインのツール通知は全体をコード装飾で囲んでいる
(`summarize.ts` の `code()`) ため、ツール引数に装飾文字が含まれても安全である。

### コード装飾を壊せるのはバッククォートだけ

コード装飾内で唯一意味を持つ文字は囲み記号そのもの:

- インラインコード内の `` ` `` は囲みを終端させて以降が地の文になる
- コードブロック内の ``` ``` ``` は囲みを終端させる (単発・2連の `` ` `` は無害)

`code()` での対処:

1. 本文に `` ` `` が含まれる場合はインラインを使わずコードブロックに逃がす
2. コードブロック内の ``` ``` ``` の連なりは各 `` ` `` の間に ZWSP (U+200B) を挟んで分断する
   (ZWSP はコード内でも不可視のため表示への影響が最小)

### メンションの ping は allowed_mentions で API 側から抑止できる

コードブロック内のメンション構文は表示上変換されないが、確実を期すため `notify.ts` の投稿 body に
`allowed_mentions: { parse: [] }` を指定し、content に `<@id>` や `@everyone` が含まれても
通知 (ping) が発生しないよう API レベルで無効化した。最終 reply は server.ts 経由の別経路であり影響しない。

## 関連する既知の知見 (docs/patch.md 側)

- メッセージ先頭/末尾の ASCII space・NBSP は Discord 側で trim されるが ZWSP は残る
- 絵文字のみのメッセージは jumbo 化する。絵文字 + ZWSP で抑止できる
- `flags: 4096` (SUPPRESS_NOTIFICATIONS) は @silent 送信。スレッド作成通知 (THREAD_CREATE) はこれでは抑止不可
