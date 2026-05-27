import { toolSummary } from './summarize'
import { sendNow, channelId } from './notify'

async function main() {
  // このセッションに担当チャンネルがなければ何もしない
  if (!channelId()) return
  const raw = await new Response(Bun.stdin.stream()).text()
  let payload: any
  try {
    payload = JSON.parse(raw)
  } catch {
    return
  }
  const name = payload.tool_name
  const input = payload.tool_input ?? {}
  if (typeof name !== 'string') return
  await sendNow(toolSummary(name, input))
}

main().catch((e: unknown) => {
  if (process.env.DISCORD_NOTIFY_DEBUG) process.stderr.write(`[posttooluse] ${e}\n`)
})
