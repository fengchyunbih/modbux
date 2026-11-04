import { Readable, Writable } from 'stream'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  JSONRPCMessage
} from '@modelcontextprotocol/sdk/types.js'
import { McpSettingsSchema } from '@shared'

/**
 * The stdio shim: an MCP server on stdin and stdout that forwards every
 * message to Modbux's HTTP endpoint, for an MCP client that speaks only stdio.
 *
 * It is a message pump, not an MCP server of its own. It declares no tool,
 * resource or prompt, so whatever the HTTP server lists is what the client
 * sees. It imports nothing from `electron`, because it runs under plain node
 * (`node out/main/mcpStdio.js`) and under the Modbux binary with
 * `ELECTRON_RUN_AS_NODE=1`, and in neither is there an app object.
 */

/** JSON-RPC's code for a server error, which is what an unreachable endpoint is. */
const SERVER_ERROR_CODE = -32000

export interface StdioShimParams {
  url: string
  token: string
  stdin?: Readable
  stdout?: Writable
  /** Where a failure that has no request to answer goes. Stdout is the protocol, so never there. */
  log?: (message: string) => void
}

export interface StdioShim {
  close: () => Promise<void>
}

/** Start the pump between stdio and the endpoint at `url`. */
export const startStdioShim = async ({
  url,
  token,
  stdin = process.stdin,
  stdout = process.stdout,
  log = (message): void => void process.stderr.write(`${message}\n`)
}: StdioShimParams): Promise<StdioShim> => {
  const stdio = new StdioServerTransport(stdin, stdout)
  const http = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  })

  const initializeIds = new Set<string | number>()
  let closing = false

  // The endpoint is stateless, but the protocol version the initialize answer
  // negotiated goes on every later request as a header.
  http.onmessage = (message: JSONRPCMessage): void => {
    if (isJSONRPCResultResponse(message) && initializeIds.delete(message.id)) {
      const version = (message.result as { protocolVersion?: unknown }).protocolVersion
      if (typeof version === 'string') http.setProtocolVersion(version)
    }
    stdio.send(message).catch((error: unknown) => log(`stdout write failed: ${String(error)}`))
  }
  http.onerror = (error): void => {
    if (!closing) log(`Modbux endpoint: ${error.message}`)
  }

  stdio.onmessage = (message: JSONRPCMessage): void => {
    if (isJSONRPCRequest(message) && message.method === 'initialize') {
      initializeIds.add(message.id)
    }
    http.send(message).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error)
      // A request owes its client an answer, or the client waits for ever.
      if (!isJSONRPCRequest(message)) return
      stdio
        .send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: SERVER_ERROR_CODE, message: `Modbux endpoint: ${reason}` }
        })
        .catch((sendError: unknown) => log(`stdout write failed: ${String(sendError)}`))
    })
  }

  const close = async (): Promise<void> => {
    if (closing) return
    closing = true
    await Promise.allSettled([http.close(), stdio.close()])
  }
  stdio.onclose = (): void => void close()
  http.onclose = (): void => void close()

  await http.start()
  await stdio.start()
  return { close }
}

//
//
// The token

/** Where Electron keeps `userData` for an app called `appName`. */
export const userDataDirectory = (
  appName: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string
): string => {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', appName)
  if (platform === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), appName)
  return join(env.XDG_CONFIG_HOME ?? join(home, '.config'), appName)
}

/**
 * The names the app's `userData` directory goes by: `Modbux` for an installed
 * app and `modbux` when it runs from the repository, where Electron takes the
 * name from package.json.
 */
export const APP_DIRECTORY_NAMES = ['Modbux', 'modbux'] as const

export const MCP_SETTINGS_FILE_NAME = 'mcp.json'

export interface TokenSources {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  home?: string
  readFile?: (path: string) => string
}

/** The token, or why there is none. */
export type TokenResult = { token: string; source: string } | { error: string }

/**
 * The Bearer token: `MODBUX_MCP_TOKEN` if set, else the token in `mcp.json` in
 * the user data directory. `MODBUX_USER_DATA` names that directory when the app
 * runs with `--user-data-dir`.
 */
export const findToken = ({
  env = process.env,
  platform = process.platform,
  home = homedir(),
  readFile = (path): string => readFileSync(path, 'utf-8')
}: TokenSources = {}): TokenResult => {
  const fromEnv = env.MODBUX_MCP_TOKEN?.trim()
  if (fromEnv) return { token: fromEnv, source: 'MODBUX_MCP_TOKEN' }

  const directories = env.MODBUX_USER_DATA
    ? [env.MODBUX_USER_DATA]
    : APP_DIRECTORY_NAMES.map((name) => userDataDirectory(name, platform, env, home))
  const tried: string[] = []
  for (const directory of directories) {
    const path = join(directory, MCP_SETTINGS_FILE_NAME)
    tried.push(path)
    try {
      const settings = McpSettingsSchema.safeParse(JSON.parse(readFile(path)))
      if (settings.success) return { token: settings.data.token, source: path }
    } catch {
      // Missing or unreadable: try the next directory.
    }
  }
  return {
    error: `No MCP token. Set MODBUX_MCP_TOKEN, or switch MCP on in Modbux (Settings) so that it writes one to: ${tried.join(' or ')}`
  }
}
