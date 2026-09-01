// PreToolUse hook. tool_input.description が日本語で書かれているかを検査する
// 拒否時は exit 2 で stderr の理由が Claude に返り 日本語で書き直して再実行される
// 対象は description を持つ全ツールで Bash / PowerShell は description 自体を必須にする

// ひらがな カタカナ 漢字のいずれかを含めば日本語とみなす
// 技術用語やコード識別子だけの英文説明を弾くための最小の判定である
// 中黒や長音記号は script が Common で文字自体は日本語でないため字種の指定で除外する
const JA_RE = /[\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Han}]/u

// description を必須とするツール (コマンド通知の説明表示に使うため欠落も拒否する)
const REQUIRE_DESC = new Set(['Bash', 'PowerShell'])

// 拒否理由を返す (許可なら null)
// description があれば日本語判定し 無ければ REQUIRE_DESC のツールのみ欠落として拒否する
export function checkDescription(toolName: unknown, input: unknown): string | null {
  const desc =
    typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>).description
      : undefined
  if (typeof desc === 'string' && desc.trim()) {
    if (JA_RE.test(desc)) return null
    return `description は日本語で書き直すこと (技術用語とコード識別子は原文のまま可): ${desc}`
  }
  if (typeof toolName === 'string' && REQUIRE_DESC.has(toolName)) {
    return 'description に日本語のコマンド説明を付けること'
  }
  return null
}

// 直接実行時は stdin の hook payload を検査する
// payload が読めない場合は許可する (hook 自体の不具合でツール実行を止めないため)
if (import.meta.main) {
  try {
    const payload = JSON.parse(
      await new Response(Bun.stdin.stream()).text(),
    ) as Record<string, unknown>
    const reason = checkDescription(payload.tool_name, payload.tool_input)
    if (reason !== null) {
      process.stderr.write(reason)
      process.exit(2)
    }
  } catch {
    // 解析失敗は許可として扱う
  }
}
