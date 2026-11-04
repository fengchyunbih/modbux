import { randomBytes } from 'crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import z from 'zod'
import { McpSettings, McpSettingsSchema } from '@shared'

/**
 * The MCP settings file, `mcp.json` in main's userData directory.
 *
 * Main reads it before any window loads, because whether the MCP server starts
 * is decided at startup. Version 1 is the only version; a later shape adds a
 * migration beside it.
 */
export const MCP_SETTINGS_FILE = 'mcp.json'

const MCP_SETTINGS_VERSION = 1

const McpSettingsFileSchema = McpSettingsSchema.extend({
  version: z.literal(MCP_SETTINGS_VERSION)
})

/** 32 random bytes, which is 43 characters of base64url. */
export const createMcpToken = (): string => randomBytes(32).toString('base64url')

/** Where the settings come from and go to. */
export interface McpSettingsStore {
  load: () => McpSettings
  save: (settings: McpSettings) => void
}

/** Both switches off, and a token nobody has seen yet. */
export const defaultMcpSettings = (createToken: () => string = createMcpToken): McpSettings => ({
  enabled: false,
  allowWrites: false,
  token: createToken()
})

interface FileSettingsStoreParams {
  path: string
  createToken?: () => string
  /** Where a file that could not be read or written is reported. */
  warn?: (message: string) => void
}

/**
 * The settings, kept in the JSON file at `path`.
 *
 * A file that is missing, unreadable or refused by the schema answers the
 * defaults, and those are written back at once so the token a client is given
 * is the one the next start reads. Both switches are off in the defaults, so a
 * damaged file can only ever turn MCP off.
 */
export const createFileSettingsStore = ({
  path,
  createToken = createMcpToken,
  warn = console.warn
}: FileSettingsStoreParams): McpSettingsStore => {
  const save = (settings: McpSettings): void => {
    try {
      mkdirSync(dirname(path), { recursive: true })
      const file = { version: MCP_SETTINGS_VERSION, ...settings }
      writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
    } catch (error) {
      warn(`The MCP settings were not saved to ${path}: ${String(error)}`)
    }
  }

  const load = (): McpSettings => {
    let text: string | undefined
    try {
      text = readFileSync(path, 'utf-8')
    } catch {
      // A first start has no file, and that is the defaults.
    }

    if (text !== undefined) {
      const parsed = McpSettingsFileSchema.safeParse(parseJson(text))
      if (parsed.success) {
        const { enabled, allowWrites, token } = parsed.data
        return { enabled, allowWrites, token }
      }
      warn(`The MCP settings in ${path} were not readable, so MCP starts switched off`)
    }

    const settings = defaultMcpSettings(createToken)
    save(settings)
    return settings
  }

  return { load, save }
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
