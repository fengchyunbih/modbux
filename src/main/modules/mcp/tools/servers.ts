import { MAIN_SERVER_UUID } from '@shared'
import z from 'zod'
import { defineTool, McpTool, toolError, toolResult } from '../registry'
import { commandFailure } from './commandFailure'
import { fileResult, importNotes } from './importNotes'

/**
 * The server lifecycle: list, create, delete, and the config file of one
 * server. Every one of them is refused while the server view is in its own
 * window, because the main window's server store is stale then.
 *
 * These change what Modbux holds and open or close TCP listeners on this
 * machine. They write to no device.
 */

const uuidField = z.string().min(1).describe('The server uuid, from server_list.')

const serverList = defineTool({
  name: 'server_list',
  title: 'List the servers',
  description:
    'Every Modbus server in Modbux: uuid, name, port, the selected unit id and main (true for the main server, which cannot be deleted), and the uuid of the one selected in the window.',
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: false },
  run: async (_input, context) => {
    try {
      const { selectedUuid, servers } = await context.rendererCommands.send('server_list')
      return toolResult({
        selectedUuid,
        servers: servers.map((server) => ({ ...server, main: server.uuid === MAIN_SERVER_UUID }))
      })
    } catch (error) {
      return toolError(commandFailure(error))
    }
  }
})

const serverCreate = defineTool({
  name: 'server_create',
  title: 'Create a server',
  description:
    'Add a Modbus TCP server, the way the Add server button does, as one undo step. Without a port the first free one from 502 is used. A port is taken exactly: one another server holds, one the system refuses and 15502, which the MCP server uses, are errors. Modbux holds at most 10 servers, and none can be added while the server view is in RTU mode. The new server is selected in the window. Answers the server with its uuid.',
  inputSchema: {
    name: z.string().optional().describe('The name shown on the server.'),
    port: z.number().int().min(1).max(65535).optional().describe('The TCP port to listen on.')
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false
  },
  run: async (input, context) => {
    try {
      const result = await context.rendererCommands.send('server_create', input)
      return result.ok ? toolResult(result.server) : toolError(result.error)
    } catch (error) {
      return toolError(commandFailure(error))
    }
  }
})

const serverDelete = defineTool({
  name: 'server_delete',
  title: 'Delete a server',
  description:
    'Delete a server and its registers, the way the Delete server button does, as one undo step in Modbux. The main server (main: true in server_list) cannot be deleted; replace what it holds with server_import_config.',
  inputSchema: { uuid: uuidField },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false
  },
  run: async ({ uuid }, context) => {
    try {
      const result = await context.rendererCommands.send('server_delete', { uuid })
      return result.ok ? toolResult({ deleted: uuid }) : toolError(result.error)
    } catch (error) {
      return toolError(commandFailure(error))
    }
  }
})

const serverExportConfig = defineTool({
  name: 'server_export_config',
  title: 'Export a server config file',
  description:
    'One server as the JSON text the server Save button writes: name, byte order, port and the registers of every unit. The answer is the file itself. Its JSON Schema is the resource modbux://schema/server-config.',
  inputSchema: { uuid: uuidField },
  annotations: { readOnlyHint: true, openWorldHint: false },
  run: async ({ uuid }, context) => {
    try {
      const { json } = await context.rendererCommands.send('server_export_config', { uuid })
      return fileResult(json)
    } catch (error) {
      return toolError(commandFailure(error))
    }
  }
})

const serverImportConfig = defineTool({
  name: 'server_import_config',
  title: 'Import a server config file',
  description:
    'Replace everything one server holds with a server config file given as JSON text, the way the server Open button does, as one undo step in Modbux. A port in the file goes through the same checks as typing it; one that is refused is reported in portRefused and the rest of the file is still loaded. The window keeps its selected server. A file that does not validate changes nothing.',
  inputSchema: {
    uuid: uuidField,
    json: z.string().describe('The server config file, as JSON text.')
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false
  },
  run: async ({ uuid, json }, context) => {
    try {
      const result = await context.rendererCommands.send('server_import_config', { uuid, json })
      if (!result.ok) return toolError(result.error)
      return toolResult({
        imported: true,
        portRefused: result.portRefused,
        notes: importNotes(result)
      })
    } catch (error) {
      return toolError(commandFailure(error))
    }
  }
})

/** The server lifecycle tools. */
export const serverTools: readonly McpTool[] = [
  serverList,
  serverCreate,
  serverDelete,
  serverExportConfig,
  serverImportConfig
]
