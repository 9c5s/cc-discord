// 公式 discord plugin キャッシュの server.ts へローカルパッチを機械適用する CLI
// 使い方:
//   bun plugin/src/patch-server.ts          patches/ の .patch を適用する (適用済みなら何もしない)
//   bun plugin/src/patch-server.ts --make   素と現キャッシュの diff から patches/<version>.patch を再生成する
// パッチの背景と各改変の設計意図は docs/patch.md を参照
import { spawnSync } from 'child_process'
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { normalizeDiffHeader, pickLatestVersion, pickPatch } from './patch-core'

// パス解決 テストでは環境変数で一時 dir に差し替える
function cacheRoot(): string {
  return process.env.CC_DISCORD_PLUGIN_CACHE
    ?? join(homedir(), '.claude', 'plugins', 'cache', 'claude-plugins-official', 'discord')
}

function marketplaceDir(): string {
  return process.env.CC_DISCORD_MARKETPLACE_DIR
    ?? join(homedir(), '.claude', 'plugins', 'marketplaces', 'claude-plugins-official', 'external_plugins', 'discord')
}

function patchesDir(): string {
  return process.env.CC_DISCORD_PATCHES_DIR ?? join(import.meta.dir, '..', '..', 'patches')
}

function fail(msg: string): never {
  process.stderr.write(`patch-server: ${msg}\n`)
  process.exit(1)
}

function info(msg: string): void {
  process.stdout.write(`patch-server: ${msg}\n`)
}

// キャッシュから対象バージョンを決める 複数あれば数値順で最新を対象にする
function resolveTarget(): { version: string; dir: string } {
  const root = cacheRoot()
  if (!existsSync(root)) fail(`プラグインキャッシュが見つからない: ${root}`)
  const names = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
  const version = pickLatestVersion(names)
  if (!version) fail(`バージョンディレクトリが見つからない: ${root}`)
  if (names.length > 1) info(`複数バージョンを検出 (${names.join(', ')}) 最新の ${version} を対象にする`)
  return { version, dir: join(root, version) }
}

// git apply を対象 dir を cwd として実行する patch は git repo 外でも適用できる
function gitApply(dir: string, patchPath: string, args: string[]): { ok: boolean; stderr: string } {
  const r = spawnSync('git', ['apply', ...args, patchPath], { cwd: dir, stdio: 'pipe', encoding: 'utf8' })
  return { ok: r.status === 0, stderr: r.stderr || r.error?.message || '' }
}

// 適用後の server.ts がトランスパイル可能か bun build で検証する
// --external '*' で依存解決をスキップし構文だけを見る (node_modules の有無に依存させない)
function bunBuildOk(dir: string): boolean {
  const out = join(dir, `.patch-verify-${process.pid}.tmp.js`)
  const r = spawnSync('bun', ['build', 'server.ts', '--target', 'node', '--external', '*', '--outfile', out], {
    cwd: dir, stdio: 'pipe',
  })
  try { rmSync(out, { force: true }) } catch { /* 一時ファイルの削除失敗は無害 */ }
  return r.status === 0
}

function apply(): void {
  const { version, dir } = resolveTarget()
  const serverTs = join(dir, 'server.ts')
  if (!existsSync(serverTs)) fail(`server.ts が見つからない: ${serverTs}`)
  const pdir = patchesDir()
  const candidates = existsSync(pdir) ? readdirSync(pdir) : []
  const picked = pickPatch(candidates, version)
  if (!picked) fail(`patches/ に .patch が見つからない: ${pdir}`)
  const patchPath = join(pdir, picked.file)

  // 逆適用チェックが通る = 既に適用済みなので何もしない (冪等)
  if (gitApply(dir, patchPath, ['--check', '--reverse']).ok) {
    info(`適用済み (${picked.file}) 何もしない`)
    return
  }
  const check = gitApply(dir, patchPath, ['--check'])
  if (!check.ok) {
    fail(
      `${picked.file} は ${version} に適用できない\n` +
      `${check.stderr.trimEnd()}\n` +
      `  docs/patch.md の意図を参照して手動適用し --make で再生成すること\n` +
      `  中途半端な状態になった場合は server.ts.orig から復元できる`,
    )
  }
  // チェック通過済みなので現物は素 これを .orig として保全し --make の基準にする
  const orig = `${serverTs}.orig`
  if (!existsSync(orig)) copyFileSync(serverTs, orig)
  // 検証失敗時の復元先は .orig でなく適用直前の内容にする
  // 同版再配布や手動修正で .orig が現物より古い場合に適用前の状態を失わないため
  const before = readFileSync(serverTs, 'utf8')
  const applied = gitApply(dir, patchPath, [])
  if (!applied.ok) {
    fail(
      `git apply が失敗した: ${applied.stderr.trimEnd()}\n` +
      `  中途半端な状態になった場合は server.ts.orig から復元できる`,
    )
  }
  // 構文検証に失敗したら適用前の状態に戻し 壊れた server.ts を残さない
  if (!bunBuildOk(dir)) {
    writeFileSync(serverTs, before, 'utf8')
    fail('適用後の bun build が失敗したため復元した パッチ内容を確認すること')
  }
  // フォールバックで当たった場合はこのバージョンで検証済みの patch として保存する
  if (!picked.exact) {
    copyFileSync(patchPath, join(pdir, `${version}.patch`))
    info(`${picked.file} が ${version} に適用できたため patches/${version}.patch として保存した コミットすること`)
  }
  info(`${version} に適用した 反映には全セッションの再起動が必要`)
}

// package.json の version 文字列を読む 失敗時は空文字
function pkgVersion(path: string): string {
  try {
    return String((JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }).version ?? '')
  } catch {
    return ''
  }
}

function make(): void {
  const { version, dir } = resolveTarget()
  const serverTs = join(dir, 'server.ts')
  if (!existsSync(serverTs)) fail(`server.ts が見つからない: ${serverTs}`)
  // 素の決定 .orig を最優先し 無ければ marketplace の素を package.json version 一致時のみ使う
  // バージョン dir 名 (例 0.0.4) は package.json version と独立に振られるため dir 名では照合しない
  let base = `${serverTs}.orig`
  if (!existsSync(base)) {
    const mdir = marketplaceDir()
    const mServer = join(mdir, 'server.ts')
    if (!existsSync(mServer)) fail('server.ts.orig が無く marketplace の素も見つからない')
    const cv = pkgVersion(join(dir, 'package.json'))
    const mv = pkgVersion(join(mdir, 'package.json'))
    if (!cv || cv !== mv) {
      fail(`server.ts.orig が無く marketplace と cache の package.json version が不一致 (${mv || '不明'} / ${cv || '不明'}) のため素を特定できない`)
    }
    info(`server.ts.orig が無いため marketplace の素を使う (package.json version ${cv} で一致) 生成結果の規模を確認すること`)
    base = mServer
  }
  const r = spawnSync('git', ['diff', '--no-index', '--', base, serverTs], {
    stdio: 'pipe', encoding: 'utf8',
  })
  // git diff --no-index は差分なしで exit 0 差分ありで exit 1 を返す
  if (r.status === 0) fail('素と現物に差分が無い (キャッシュは未改変)')
  if (r.status !== 1 || !r.stdout) fail(`git diff が失敗した: ${r.stderr || r.error?.message || ''}`)
  const normalized = normalizeDiffHeader(r.stdout)
  const pdir = patchesDir()
  mkdirSync(pdir, { recursive: true })
  writeFileSync(join(pdir, `${version}.patch`), normalized, 'utf8')
  // 本家差分の混入などの異常規模に気付けるよう diffstat を表示する
  // ヘッダの --- +++ 各 1 行を除いて数える
  const plus = (normalized.match(/^\+/gm) ?? []).length - 1
  const minus = (normalized.match(/^-/gm) ?? []).length - 1
  info(`patches/${version}.patch を生成した (+${plus}/-${minus})`)
}

if (process.argv.includes('--make')) {
  make()
} else {
  apply()
}
