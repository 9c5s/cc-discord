#!/usr/bin/env bun
// cc-discord 透過プロキシ (spike 段階)
// Claude Code と公式 discord channel server (server.ts) の間に入り stdio の JSON-RPC を中継する
// 公式 server は無改変のまま子プロセスとして起動し 差し込みたい振る舞いは MCP 境界と
// Discord REST で実現する 現段階の範囲は次の 3 点である
//   1. 双方向の行単位中継 (MCP stdio は改行区切り JSON-RPC)
//   2. server -> client の inbound 通知 (notifications/claude/channel) を検知して typing を継続送信する
//   3. client -> server の reply ツール呼び出しで typing を停止する

import { spawn } from 'child_process'
import { appendFileSync, mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { StringDecoder } from 'string_decoder'
import { botToken, ownerName } from './notify'
import { stateDir } from './routes'

const API = 'https://discord.com/api/v10'
const TYPING_RESEND_MS = 8_000
const TYPING_MAX_MS = 10 * 60_000

type Json = Record<string, unknown>

// 観測用ログ (spike 段階では常時出力する)
// stateDir/logs/proxy-<owner>.log へ追記し 失敗しても本体を止めない
function log(msg: string): void {
  try {
    const dir = join(stateDir(), 'logs')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    appendFileSync(join(dir, `proxy-${ownerName() || 'unknown'}.log`), `[${new Date().toISOString()}] ${msg}\n`, { mode: 0o600 })
  } catch {
    // ログ失敗は無視する
  }
}

// 公式 discord プラグインのインストール先を installed_plugins.json から解決する
// user scope を優先し 無ければ最初のエントリを使う
export function officialPluginDir(configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')): string {
  const reg = JSON.parse(readFileSync(join(configDir, 'plugins', 'installed_plugins.json'), 'utf8')) as Json
  const plugins = (reg.plugins ?? {}) as Record<string, Array<{ scope?: string; installPath?: string }>>
  const entries = plugins['discord@claude-plugins-official'] ?? []
  const path = entries.find((e) => e.scope === 'user')?.installPath ?? entries[0]?.installPath
  if (!path) throw new Error('discord@claude-plugins-official is not installed')
  return path
}

// typing 継続 ---
// Discord の typing は約 10 秒で消えるため 8 秒毎に再送し reply で止める
// 安全弁として 10 分で必ず止める
type TypingState = { timer: ReturnType<typeof setInterval>; guard: ReturnType<typeof setTimeout> }
const typing = new Map<string, TypingState>()

async function sendTyping(chatId: string): Promise<void> {
  const t = botToken()
  if (!t) {
    log('typing skip: no token')
    return
  }
  try {
    const res = await fetch(`${API}/channels/${chatId}/typing`, {
      method: 'POST',
      headers: { Authorization: `Bot ${t}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) log(`typing http error status=${res.status}`)
  } catch (e) {
    log(`typing fetch failed: ${e}`)
  }
}

function startTyping(chatId: string): void {
  if (typing.has(chatId)) return
  void sendTyping(chatId)
  const timer = setInterval(() => void sendTyping(chatId), TYPING_RESEND_MS)
  timer.unref?.()
  const guard = setTimeout(() => clearTyping(chatId), TYPING_MAX_MS)
  guard.unref?.()
  typing.set(chatId, { timer, guard })
  log(`typing start chat=${chatId}`)
}

function clearTyping(chatId: string): void {
  const s = typing.get(chatId)
  if (!s) return
  clearInterval(s.timer)
  clearTimeout(s.guard)
  typing.delete(chatId)
  log(`typing stop chat=${chatId}`)
}

// 行単位の中継 ---
// 1 行 = 1 JSON-RPC メッセージとして解析し handler に渡す
// handler が null を返した行は破棄し それ以外は元の行をそのまま書き出す (バイト列を保存する)
// JSON として解析できない行は無条件で素通しする
export type LineHandler = (msg: Json) => Json | null

export function relayLines(
  src: NodeJS.ReadableStream,
  dst: NodeJS.WritableStream,
  handler: LineHandler,
): void {
  const decoder = new StringDecoder('utf8')
  let buf = ''
  src.on('data', (chunk: Buffer) => {
    buf += decoder.write(chunk)
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      let msg: Json
      try {
        msg = JSON.parse(line) as Json
      } catch {
        dst.write(`${line}\n`)
        continue
      }
      const out = handler(msg)
      if (out === null) continue
      dst.write(out === msg ? `${line}\n` : `${JSON.stringify(out)}\n`)
    }
  })
}

// server -> client: inbound 通知を検知して typing を始める
function fromServer(msg: Json): Json | null {
  if (msg.method === 'notifications/claude/channel') {
    const meta = ((msg.params as Json | undefined)?.meta ?? {}) as Json
    const chatId = typeof meta.chat_id === 'string' ? meta.chat_id : null
    log(`inbound message_id=${String(meta.message_id ?? '')} chat=${chatId ?? ''}`)
    if (chatId) startTyping(chatId)
  } else if (msg.id !== undefined && (msg.result as Json | undefined)?.capabilities !== undefined) {
    const caps = (msg.result as Json).capabilities as Json
    log(`initialize result experimental=${JSON.stringify(caps.experimental ?? null)}`)
  }
  return msg
}

// client -> server: reply ツール呼び出しで typing を止める
function fromClient(msg: Json): Json | null {
  if (msg.method === 'tools/call') {
    const params = (msg.params ?? {}) as Json
    const args = (params.arguments ?? {}) as Json
    log(`tools/call name=${String(params.name)}`)
    if (params.name === 'reply' && typeof args.chat_id === 'string') clearTyping(args.chat_id)
  }
  return msg
}

function main(): void {
  // 検証用の上書き: セッションの起動ディレクトリとは別の担当名で子 server を動かす
  // (spike 段階で公式プラグインの server と担当を分けて競合させないための仕掛け)
  const override = process.env.CC_DISCORD_PROJECT_DIR
  if (override) process.env.CLAUDE_PROJECT_DIR = override
  const dir = officialPluginDir()
  log(`start pid=${process.pid} owner=${ownerName() || '(none)'} official=${dir}`)
  // 公式 .mcp.json と同じ起動コマンドで server.ts を子プロセスにする
  const child = spawn(process.execPath, ['run', '--cwd', dir, '--shell=bun', '--silent', 'start'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  })
  child.on('error', (e) => {
    log(`child spawn failed: ${e.message}`)
    process.exit(1)
  })
  child.on('exit', (code, signal) => {
    log(`child exit code=${code} signal=${signal}`)
    process.exit(code ?? (signal === null ? 0 : 1))
  })
  // 子が先に終了した際の EPIPE で異常終了しないようにする
  child.stdin.on('error', () => {})
  process.stdout.on('error', () => process.exit(0))

  relayLines(child.stdout, process.stdout, fromServer)
  relayLines(process.stdin, child.stdin, fromClient)

  // Claude Code が接続を閉じたら子にも EOF を伝えて Gateway を切らせる
  let shuttingDown = false
  const shutdown = (): void => {
    if (shuttingDown) return
    shuttingDown = true
    log('stdin closed, shutting down')
    child.stdin.end()
    setTimeout(() => process.exit(0), 3_000).unref?.()
  }
  process.stdin.on('end', shutdown)
  process.stdin.on('close', shutdown)
  process.on('SIGTERM', () => child.kill())
  process.on('SIGINT', () => child.kill())
}

if (import.meta.main) main()
