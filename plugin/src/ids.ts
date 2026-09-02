import { join } from 'path'

// 識別子の形式検証 ---
// REST の URL やファイル名に埋める値は 埋める直前にここで検証する
// 検証を通らない値は 通知の破棄 / isError 応答 / 該当操作の中止として扱い REST もファイル操作も行わない

// Discord snowflake (17 桁から 20 桁の数字列)
export function isSnowflake(v: unknown): v is string {
  return typeof v === 'string' && /^\d{17,20}$/.test(v)
}

// Claude Code の session_id (小文字 16 進の UUID 形式)
export function isSessionId(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)
}

// run_id と activation_id (小文字 16 進 32 文字)
export function isHex32(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{32}$/.test(v)
}

// 正規化済みの担当名 (小文字の英数とハイフン)
// state dir のファイル名に埋める前に必ずこれを通す
export function isOwnerName(v: unknown): v is string {
  return typeof v === 'string' && /^[a-z0-9-]+$/.test(v)
}

// プロセス ID (1 桁から 10 桁の数字列)
export function isPid(v: unknown): v is string {
  return typeof v === 'string' && /^\d{1,10}$/.test(v)
}

// 対象ディレクトリ直下のパスを解決する
// 区切り文字や親参照を含む名前は直下にならないため拒否し null を返す
// 拒否した名前では読み書きも削除も行わない
export function resolveInDir(dir: string, name: string): string | null {
  if (!name || name === '.' || name === '..') return null
  if (name.includes('/') || name.includes('\\')) return null
  return join(dir, name)
}
