import z from 'zod'
import { defineTool, McpTool, toolError, toolResult } from '../registry'
import { commandFailure } from './commandFailure'
import { fileResult, importNotes } from './importNotes'

/**
 * The project file: one client and every server, as JSON text. Refused while
 * the server view is in its own window, as the Save project and Open project
 * buttons are.
 */

const projectExport = defineTool({
  name: 'project_export',
  title: 'Export the project file',
  description:
    'The client configuration and every server (port, byte order, registers), with the server view mode and serial settings, as the JSON text the Save project button writes. The answer is the file itself. Its JSON Schema is the resource modbux://schema/project.',
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: false },
  run: async (_input, context) => {
    try {
      const { json } = await context.rendererCommands.send('project_export')
      return fileResult(json)
    } catch (error) {
      return toolError(commandFailure(error))
    }
  }
})

const projectImport = defineTool({
  name: 'project_import',
  title: 'Import a project file',
  description:
    'Replace the client configuration and all servers with a project file given as JSON text, the way the Open project button does. The servers are replaced, not merged: the main server takes the first server of the file, the others are deleted and the rest of the file is created new. A port that was not available is skipped and reported in portsRefused; servers Modbux would not create are counted in serversRefused. A file that does not validate, or client connection settings that differ while the client is connected, change nothing.',
  inputSchema: { json: z.string().describe('The project file, as JSON text.') },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false
  },
  run: async ({ json }, context) => {
    try {
      const result = await context.rendererCommands.send('project_import', { json })
      if (!result.ok) return toolError(result.error)
      return toolResult({
        imported: true,
        portsRefused: result.portsRefused,
        serversRefused: result.serversRefused,
        notes: importNotes(result)
      })
    } catch (error) {
      return toolError(commandFailure(error))
    }
  }
})

/** The project tools. */
export const projectTools: readonly McpTool[] = [projectExport, projectImport]
