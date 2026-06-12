// patch-server.ts (discord plugin キャッシュへのパッチ機械適用) のコアロジック
// 子プロセスやファイルシステムに触れる処理は patch-server.ts に置き
// 本ファイルはテスト可能な純関数のみを持つ

// バージョン dir 名 (例 0.0.4) を数値配列に解析する 数字とドット以外を含む名前は null
export function parseVersion(name: string): number[] | null {
  if (!/^\d+(\.\d+)*$/.test(name)) return null
  return name.split('.').map(Number)
}

// バージョン数値配列を比較する 欠けた要素は 0 とみなす
export function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

// 名前のリストから最新バージョン名を返す 不正な名前は無視する
export function pickLatestVersion(names: string[]): string | null {
  let best: string | null = null
  let bestV: number[] | null = null
  for (const n of names) {
    const v = parseVersion(n)
    if (!v) continue
    if (!bestV || compareVersions(v, bestV) > 0) {
      best = n
      bestV = v
    }
  }
  return best
}

// patches/ のファイル名リストから適用候補を選ぶ
// 対象バージョンの完全一致を優先し 無ければ最新バージョンの .patch にフォールバックする
export function pickPatch(
  available: string[],
  target: string,
): { file: string; exact: boolean } | null {
  const versions = available
    .filter((f) => f.endsWith('.patch'))
    .map((f) => f.slice(0, -'.patch'.length))
  if (versions.includes(target)) return { file: `${target}.patch`, exact: true }
  const latest = pickLatestVersion(versions)
  if (latest === null) return null
  return { file: `${latest}.patch`, exact: false }
}

// git diff --no-index の出力ヘッダを a/server.ts b/server.ts に正規化する
// 公開リポジトリに置く patch ファイルへローカル絶対パスを残さないための処理
// 最初の +++ 行までをヘッダとみなし hunk 本体 (削除行の --- 等) は変更しない
export function normalizeDiffHeader(diff: string): string {
  const lines = diff.split('\n')
  const out: string[] = []
  let inHeader = true
  for (const line of lines) {
    if (inHeader) {
      if (line.startsWith('diff --git ')) {
        out.push('diff --git a/server.ts b/server.ts')
        continue
      }
      if (line.startsWith('--- ')) {
        out.push('--- a/server.ts')
        continue
      }
      if (line.startsWith('+++ ')) {
        out.push('+++ b/server.ts')
        inHeader = false
        continue
      }
    }
    out.push(line)
  }
  return out.join('\n')
}
