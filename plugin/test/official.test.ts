import { test, expect } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  SUPPORTED_SERVERS,
  inspectOfficial,
  isSupportedServer,
  officialPluginDir,
  sha256File,
  versionOf,
} from '../src/official'

// 一時ディレクトリを作り fn に渡して 後片付けする
function withTmpDir(fn: (dir: string) => void): void {
  const dir = join(tmpdir(), `cc-discord-official-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`)
  mkdirSync(dir, { recursive: true })
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// 空文字列の SHA-256 (既知の値)
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

// --- sha256File ---

test('sha256File はファイルの SHA-256 を 16 進小文字で返す', () => {
  withTmpDir((dir) => {
    const f = join(dir, 'x.ts')
    writeFileSync(f, '')
    expect(sha256File(f)).toBe(EMPTY_SHA)
  })
})

test('sha256File は読めないファイルで null を返す', () => {
  withTmpDir((dir) => {
    expect(sha256File(join(dir, 'missing.ts'))).toBe(null)
  })
})

// --- versionOf ---

test('versionOf は installPath の末尾ディレクトリ名を版として返す', () => {
  expect(versionOf('C:\\cache\\claude-plugins-official\\discord\\0.0.4')).toBe('0.0.4')
  expect(versionOf('/cache/claude-plugins-official/discord/0.0.4/')).toBe('0.0.4')
})

test('versionOf は区切りが混在していても末尾を返す', () => {
  // ホストの区切りに依存しないことを固定する (POSIX 上でも Windows のパスを解析できる)
  expect(versionOf('C:\\cache/claude-plugins-official\\discord/0.0.4')).toBe('0.0.4')
  expect(versionOf('C:\\cache\\discord\\0.0.4\\')).toBe('0.0.4')
})

// --- isSupportedServer ---

test('isSupportedServer は対応表にある版と hash を受け入れる', () => {
  expect(isSupportedServer('0.0.4', 'aaaa', { '0.0.4': ['aaaa', 'bbbb'] })).toBe(true)
})

test('isSupportedServer は表にない hash を拒否する', () => {
  expect(isSupportedServer('0.0.4', 'cccc', { '0.0.4': ['aaaa'] })).toBe(false)
})

test('isSupportedServer は表にない版を拒否する', () => {
  expect(isSupportedServer('0.0.5', 'aaaa', { '0.0.4': ['aaaa'] })).toBe(false)
})

test('isSupportedServer は hash が null なら拒否する', () => {
  expect(isSupportedServer('0.0.4', null, { '0.0.4': ['aaaa'] })).toBe(false)
})

// --- officialPluginDir ---

function withRegistry(registry: unknown, fn: (configDir: string) => void): void {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'plugins'), { recursive: true })
    writeFileSync(join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify(registry))
    fn(dir)
  })
}

test('officialPluginDir は user scope の installPath を優先する', () => {
  withRegistry({
    plugins: {
      'discord@claude-plugins-official': [
        { scope: 'project', installPath: 'C:\\proj\\discord' },
        { scope: 'user', installPath: 'C:\\user\\discord' },
      ],
    },
  }, (dir) => {
    expect(officialPluginDir(dir)).toBe('C:\\user\\discord')
  })
})

test('officialPluginDir は user scope が無ければ先頭のエントリを使う', () => {
  withRegistry({
    plugins: { 'discord@claude-plugins-official': [{ scope: 'project', installPath: 'C:\\proj\\discord' }] },
  }, (dir) => {
    expect(officialPluginDir(dir)).toBe('C:\\proj\\discord')
  })
})

test('officialPluginDir は公式プラグイン未インストール時に throw する', () => {
  withRegistry({ plugins: {} }, (dir) => {
    expect(() => officialPluginDir(dir)).toThrow('not installed')
  })
})

// --- inspectOfficial ---

test('inspectOfficial は実行ファイルと素のファイルの hash と対応状況を返す', () => {
  withTmpDir((dir) => {
    const versionDir = join(dir, '0.0.4')
    mkdirSync(versionDir)
    writeFileSync(join(versionDir, 'server.ts'), 'patched')
    writeFileSync(join(versionDir, 'server.ts.orig'), '')
    const info = inspectOfficial(versionDir, { '0.0.4': [EMPTY_SHA] })
    expect(info.installPath).toBe(versionDir)
    expect(info.version).toBe('0.0.4')
    expect(info.pristineHash).toBe(EMPTY_SHA)
    expect(info.execHash).not.toBe(EMPTY_SHA)
    expect(info.supported).toBe(false)
    expect(info.pristineSupported).toBe(true)
  })
})

test('inspectOfficial は server.ts.orig が無ければ素の hash を null にする', () => {
  withTmpDir((dir) => {
    const versionDir = join(dir, '0.0.4')
    mkdirSync(versionDir)
    writeFileSync(join(versionDir, 'server.ts'), '')
    const info = inspectOfficial(versionDir, { '0.0.4': [EMPTY_SHA] })
    expect(info.pristineHash).toBe(null)
    expect(info.pristineSupported).toBe(false)
    expect(info.execHash).toBe(EMPTY_SHA)
    expect(info.supported).toBe(true)
  })
})

// --- 契約テスト ---
// 対応表とインストール済み公式の素の server.ts の整合を確認する
// 上流更新の際に表の更新を強制するための検査であり 起動時判定 (実行ファイルの検査) とは別である

test('対応表にインストール済み公式の素の server.ts の hash が含まれる', () => {
  let dir: string
  try {
    dir = officialPluginDir()
  } catch {
    return // 公式が未インストールの環境では skip する
  }
  const pristine = existsSync(join(dir, 'server.ts.orig')) ? join(dir, 'server.ts.orig') : join(dir, 'server.ts')
  const hash = sha256File(pristine)
  expect(isSupportedServer(versionOf(dir), hash, SUPPORTED_SERVERS)).toBe(true)
})
