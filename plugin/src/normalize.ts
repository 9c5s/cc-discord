// ディレクトリ名と Discord チャンネル名を突き合わせるための正規化
// 小文字化 / 空白/アンダースコアをハイフン化 / 英数とハイフン以外を除去 /
// 連続ハイフンを1つに / 前後のハイフンを除去
export function normalizeName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

// ディレクトリパスのベース名を正規化して所有者名にする
// Windows (\\) と POSIX (/) の両対応で末尾の区切り文字を除去し
// ベース名を抽出して normalizeName に通す
// パスが無効な場合は空文字を返す
export function ownerFromDir(dir: string): string {
  const base = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  return normalizeName(base)
}
