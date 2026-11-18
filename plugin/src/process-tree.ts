import { dlopen, FFIType, ptr } from 'bun:ffi'
import { spawnSync } from 'child_process'
import { readFileSync } from 'fs'

export type ProcessInfo = { pid: number; ppid: number; startMs: number; argv: string[] | null }
export type ProcessLookup = { kind: 'found'; info: ProcessInfo } | { kind: 'missing' } | { kind: 'error' }

// 二重引用符の外の空白で区切り二重引用符自体は引数に残さない
export function splitCommandLine(cmd: string): string[] {
  const args: string[] = []
  let current = ''
  let inQuote = false
  let started = false
  for (const ch of cmd) {
    if (ch === '"') {
      inQuote = !inQuote
      started = true
    } else if (!inQuote && (ch === ' ' || ch === '\t')) {
      if (started) args.push(current)
      current = ''
      started = false
    } else {
      current += ch
      started = true
    }
  }
  if (started) args.push(current)
  return args
}

// /proc/<pid>/stat から ppid と starttime (起動からの clock tick) を読む
export function parseProcStat(text: string): { ppid: number; startTicks: number } | null {
  const close = text.lastIndexOf(')')
  if (close < 0) return null
  // コマンド名より後ろの先頭が 3 番目の state で ppid は 4 番目 starttime は 22 番目
  const rest = text.slice(close + 1).trim().split(/\s+/)
  if (rest.length < 20) return null
  const ppid = Number(rest[1])
  const startTicks = Number(rest[19])
  if (!Number.isInteger(ppid) || !Number.isInteger(startTicks)) return null
  return { ppid, startTicks }
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const PROCESS_BASIC_INFORMATION_CLASS = 0
const PROCESS_COMMAND_LINE_CLASS = 60
const FILETIME_EPOCH_OFFSET = 116444736000000000n

function openWin32() {
  const kernel32 = dlopen('kernel32.dll', {
    OpenProcess: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.ptr },
    GetProcessTimes: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
  })
  const ntdll = dlopen('ntdll.dll', {
    NtQueryInformationProcess: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  })
  return { k: kernel32.symbols, n: ntdll.symbols }
}

let win32: ReturnType<typeof openWin32> | undefined

function queryWin32(pid: number): ProcessInfo | null {
  win32 ??= openWin32()
  const { k, n } = win32
  const handle = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
  if (!handle) return null
  try {
    const returned = new Uint32Array(1)

    // creation と exit と kernel と user の 4 つの FILETIME を受ける
    const times = new BigUint64Array(4)
    const timesPtr = ptr(times)
    if (!k.GetProcessTimes(handle, timesPtr, timesPtr + 8, timesPtr + 16, timesPtr + 24)) return null
    const startMs = Number((times[0] - FILETIME_EPOCH_OFFSET) / 10000n)

    // PROCESS_BASIC_INFORMATION は 48 バイトで親の PID は 6 番目の 8 バイト
    const basic = new BigUint64Array(6)
    if (n.NtQueryInformationProcess(handle, PROCESS_BASIC_INFORMATION_CLASS, ptr(basic), 48, ptr(returned)) !== 0) return null
    const ppid = Number(basic[5])

    const buf = new Uint8Array(65536)
    const bufPtr = ptr(buf)
    const status = n.NtQueryInformationProcess(handle, PROCESS_COMMAND_LINE_CLASS, bufPtr, buf.length, ptr(returned))
    return { pid, ppid, startMs, argv: status === 0 ? decodeCommandLine(buf, bufPtr) : null }
  } finally {
    k.CloseHandle(handle)
  }
}

// 先頭の UNICODE_STRING (Length は 0 バイト目 Buffer は 8 バイト目) が指す文字列を引数へ分ける
function decodeCommandLine(buf: Uint8Array, base: number): string[] | null {
  const view = new DataView(buf.buffer)
  const length = view.getUint16(0, true)
  // Buffer は渡したバッファの内側を指すので先頭からの位置へ換算する
  const offset = Number(view.getBigUint64(8, true)) - base
  if (offset < 16 || offset + length > buf.length) return null
  const args = splitCommandLine(new TextDecoder('utf-16le').decode(buf.subarray(offset, offset + length)))
  return args.length > 0 ? args : null
}

let clockTicks: number | undefined

function clockTicksPerSecond(): number {
  if (clockTicks === undefined) {
    const r = spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' })
    const value = Number.parseInt(r.stdout ?? '', 10)
    clockTicks = r.status === 0 && value > 0 ? value : 100
  }
  return clockTicks
}

function queryLinux(pid: number): ProcessInfo | null {
  const stat = parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  const boot = /^btime\s+(\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))
  if (!stat || !boot) return null
  const startMs = Number(boot[1]) * 1000 + Math.floor((stat.startTicks * 1000) / clockTicksPerSecond())
  return { pid, ppid: stat.ppid, startMs, argv: readCmdlineLinux(pid) }
}

function readCmdlineLinux(pid: number): string[] | null {
  try {
    const parts = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
    if (parts[parts.length - 1] === '') parts.pop()
    return parts.length > 0 ? parts : null
  } catch {
    return null
  }
}

function runPs(args: string[]): string | null {
  const r = spawnSync('ps', args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
  return r.status === 0 ? r.stdout : null
}

function queryDarwin(pid: number): ProcessInfo | null {
  const parsed = /^\s*(\d+)\s+(.+?)\s*$/.exec(runPs(['-o', 'ppid=,lstart=', '-p', String(pid)]) ?? '')
  if (!parsed) return null
  const startMs = new Date(parsed[2]).getTime()
  if (Number.isNaN(startMs)) return null
  // ps の出力は引数の区切りを保たないので空白で分ける
  const args = runPs(['-ww', '-o', 'args=', '-p', String(pid)])?.trim().split(/\s+/)
  return { pid, ppid: Number(parsed[1]), startMs, argv: args && args[0] ? args : null }
}

function queryProcess(pid: number): ProcessInfo | null {
  switch (process.platform) {
    case 'win32':
      return queryWin32(pid)
    case 'linux':
      return queryLinux(pid)
    case 'darwin':
      return queryDarwin(pid)
    default:
      return null
  }
}

// PID のプロセスの親 PID と作成時刻と起動引数を返す (例外は外へ出さない)
export function lookupProcess(pid: number): ProcessLookup {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { kind: 'error' }
  try {
    process.kill(pid, 0)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return { kind: 'missing' }
    if (code !== 'EPERM') return { kind: 'error' }
  }
  try {
    const info = queryProcess(pid)
    return info ? { kind: 'found', info } : { kind: 'error' }
  } catch {
    return { kind: 'error' }
  }
}
