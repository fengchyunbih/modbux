import z from 'zod'
import { defineTool, McpTool, toolError, toolResult } from '../registry'
import { commandFailure } from './commandFailure'
import { fileResult, importNotes } from './importNotes'

/**
 * The client config file as JSON text.
 *
 * The file travels as a string, not a path: main writes nowhere an agent
 * names, and the agent saves the text where it wants it
 * (`docs/design/json-config-and-mcp.md`, JSON 與 MCP 的關係).
 */

const clientExportConfig = defineTool({
  name: 'client_export_config',
  title: 'Export the client config file',
  description:
    'The client configuration as the JSON text the Save button writes: name, connection, register config, byte order and the register mapping. The answer is the file itself, ready to save or to pass to client_import_config. Its JSON Schema is the resource modbux://schema/client-config.',
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: false },
  run: async (_input, context) => {
    try {
      const { json } = await context.rendererCommands.send('client_export_config')
      return fileResult(json)
    } catch (error) {
      return toolError(commandFailure(error))
    }
  }
})

const clientImportConfig = defineTool({
  name: 'client_import_config',
  title: 'Import a client config file',
  description:
    'Replace the client configuration with a client config file given as JSON text, the way the Open button does, as one undo step in Modbux. A file from an older Modbux is migrated and the answer says so. A file with connection settings that differ from the current ones is refused while the client is connected; call client_disconnect first. A file that does not validate changes nothing and the error says why.',
  inputSchema: { json: z.string().describe('The client config file, as JSON text.') },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false
  },
  run: async ({ json }, context) => {
    try {
      const result = await context.rendererCommands.send('client_import_config', { json })
      if (!result.ok) return toolError(result.error)
      return toolResult({ imported: true, notes: importNotes(result) })
    } catch (error) {
      return toolError(commandFailure(error))
    }
  }
})

/** The config file tools of the client. */
export const configFileTools: readonly McpTool[] = [clientExportConfig, clientImportConfig]
