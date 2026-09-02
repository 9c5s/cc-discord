// 互換 shim
// global settings.json の SessionStart hook が指す symlink の参照先である
// watcher の起動はプラグインの hooks (session-start.ts) が担うようになったため ここでは何もしない
// global 側と二重に発火して watcher が 2 本になるのを防ぐための空実装である
// 移行手順で global の hook 登録と symlink を外した後 次のリリースでこのファイルを削除する

// stdin を読み捨てる (読まずに終了すると呼び出し側の書き込みが失敗しうる)
await new Response(Bun.stdin.stream()).text()
