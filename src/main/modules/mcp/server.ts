import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { McpTool, McpToolContext, registerTools } from './registry'
import { registerResources } from './resources'
import { registerPrompts } from './prompts'
import { clientTools } from './tools/client'
import { configFileTools } from './tools/configFiles'
import { projectTools } from './tools/project'
import { scanTools } from './tools/scan'
import { serverTools } from './tools/servers'
import { serverPointTools } from './tools/serverPoints'

/**
 * Every tool group, one file each under `tools/`.
 *
 * A group is an array of `defineTool` results. A tool joins its group's array;
 * a new group is a new file and one entry here.
 */
export const TOOL_GROUPS: readonly (readonly McpTool[])[] = [
  clientTools,
  configFileTools,
  serverTools,
  projectTools,
  scanTools,
  serverPointTools
]

const INSTRUCTIONS = `Modbux is a Modbus TCP/RTU client and server on the user's machine. The client tools drive the one Modbus client in the Modbux main window, and the user sees every change there. Addresses are PDU addresses (0-based); read the resource modbux://encoding for data type widths, byte order and address notation before mapping a point table. Config files travel as JSON text: the export tools answer the file, the import tools take it, and the schemas are the modbux://schema/* resources. Every tool needs the Modbux main window to be open.`

/** One MCP server with every tool and resource, answering for `context`. */
export const createMcpServer = (context: McpToolContext, version: string): McpServer => {
  const server = new McpServer(
    { name: 'modbux', title: 'Modbux', version },
    { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: INSTRUCTIONS }
  )
  registerTools(server, TOOL_GROUPS, context)
  registerResources(server, context)
  registerPrompts(server)
  return server
}
