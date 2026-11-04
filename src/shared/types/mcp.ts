import z from 'zod'

//
//
// MCP server settings and status
//
// The MCP server runs in main and is configured from the settings page. Main
// keeps the settings, because it has to know them at startup to start the
// server before any window has loaded.

/**
 * The one port the MCP server listens on.
 *
 * Fixed rather than configurable, because an MCP client is configured with the
 * URL and a server that moved would be one nobody finds. It sits above the
 * 502 to 10502 walk `findAvailablePort` takes for Modbus servers and below
 * every platform's default ephemeral range, so neither Modbux nor an outgoing
 * connection takes it (`docs/design/json-config-and-mcp.md`, 已決定 5).
 */
export const MCP_PORT = 15502

/** What `setPort` in main answers a Modbus server asking for `MCP_PORT`. */
export const MCP_PORT_RESERVED = `Port ${MCP_PORT} is reserved for the MCP server`

/** The host the MCP server binds, which no other machine can reach. */
export const MCP_HOST = '127.0.0.1'

/** The path the Streamable HTTP endpoint answers on. */
export const MCP_PATH = '/mcp'

/** The URL an MCP client is configured with. */
export const mcpUrl = (port: number = MCP_PORT): string => `http://${MCP_HOST}:${port}${MCP_PATH}`

/** The command that registers Modbux with Claude Code, token included. */
export const claudeCodeMcpCommand = (token: string): string =>
  `claude mcp add --transport http modbux ${mcpUrl()} --header "Authorization: Bearer ${token}"`

/** How the stdio shim is started on this machine. */
export interface McpStdioLaunch {
  /** The binary that runs the shim: `node` itself, or the Modbux binary run as node. */
  executable: string
  /** The shim script, `mcpStdio.js` beside the app's main bundle. */
  script: string
  /** Whether `executable` is the Modbux binary, which needs `ELECTRON_RUN_AS_NODE=1`. */
  electronBinary: boolean
}

/** The shim's command line, for an MCP client that takes a command and arguments. */
export const mcpStdioCommand = ({ executable, script, electronBinary }: McpStdioLaunch): string =>
  `${electronBinary ? 'ELECTRON_RUN_AS_NODE=1 ' : ''}"${executable}" "${script}"`

/** The command that registers the stdio shim with Claude Code. The shim finds the token itself. */
export const claudeCodeStdioCommand = ({
  executable,
  script,
  electronBinary
}: McpStdioLaunch): string =>
  `claude mcp add modbux${electronBinary ? ' --env ELECTRON_RUN_AS_NODE=1' : ''} -- "${executable}" "${script}"`

/**
 * What the MCP server is doing.
 *
 * - `stopped`: not listening, because it is switched off.
 * - `running`: listening on `MCP_PORT`.
 * - `error`: switched on and not listening; `error` says why.
 */
export const McpRunStateSchema = z.enum(['stopped', 'running', 'error'])
export type McpRunState = z.infer<typeof McpRunStateSchema>

/** The settings main persists, as the settings page sees them. */
export const McpSettingsSchema = z.object({
  enabled: z.boolean(),
  allowWrites: z.boolean(),
  token: z.string().min(1)
})
export type McpSettings = z.infer<typeof McpSettingsSchema>

/** What `get_mcp_status` and `mcp_status` carry. */
export interface McpStatus extends McpSettings {
  state: McpRunState
  /** Why the server is not listening while it is switched on. */
  error?: string
  url: string
  /** The stdio shim's command lines. Absent when main was not told where the shim is. */
  stdio?: { command: string; claudeCodeCommand: string }
}
