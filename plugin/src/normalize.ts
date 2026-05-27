// ディレクトリ名と Discord チャンネル名を突き合わせるための正規化。
// 小文字化 / 空白・アンダースコアをハイフン化 / 英数とハイフン以外を除去 /
// 連続ハイフンを1つに / 前後のハイフンを除去。
export function normalizeName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}
