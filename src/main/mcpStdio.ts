import { mcpUrl } from '@shared'
import { findToken, startStdioShim } from './modules/mcp/stdioShim'

/**
 * Entry of the stdio shim, built to `out/main/mcpStdio.js`.
 *
 *   node out/main/mcpStdio.js
 *   ELECTRON_RUN_AS_NODE=1 <Modbux binary> <resources>/app.asar/out/main/mcpStdio.js
 *
 * Stdout carries the protocol, so every message to the person goes to stderr.
 */
const main = async (): Promise<void> => {
  const found = findToken()
  if ('error' in found) {
    process.stderr.write(`${found.error}\n`)
    process.exit(1)
  }
  const url = process.env.MODBUX_MCP_URL ?? mcpUrl()
  await startStdioShim({ url, token: found.token })
  process.stderr.write(`modbux-mcp: forwarding stdio to ${url}\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`modbux-mcp: ${String(error)}\n`)
  process.exit(1)
})
