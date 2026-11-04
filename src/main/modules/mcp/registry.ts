import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import z, { ZodRawShape } from 'zod'
import type { AppState } from '../../state'
import type { ModbusClient } from '../modbusClient'
import type { RendererCommands } from '../rendererCommands'

/**
 * What a tool reaches, handed in by `index.ts`.
 *
 * Each member is the narrowest slice of the real object a tool uses, so a test
 * hands in a stand-in for the slice rather than a whole `ModbusClient`.
 */
export interface McpToolContext {
  client: Pick<
    ModbusClient,
    | 'read'
    | 'state'
    | 'lastConnectError'
    | 'scanRegisters'
    | 'scanUnitIds'
    | 'stopScanningRegisters'
    | 'stopScanningUnitIds'
  >
  appState: Pick<
    AppState,
    'connectionConfig' | 'registerConfig' | 'registerMapping' | 'readConfiguration'
  >
  rendererCommands: Pick<RendererCommands, 'send'>
  /** Whether the main window is open, which every tool needs (已決定 4). */
  mainWindowOpen: () => boolean
  /** The "Allow writes to devices" switch, read per call. */
  allowWrites: () => boolean
}

interface ToolDefinition<Shape extends ZodRawShape> {
  name: string
  title: string
  description: string
  /** The arguments, as the properties of one object. `{}` takes none. */
  inputSchema: Shape
  annotations: ToolAnnotations
  /**
   * A tool that changes what a device holds. It is refused while "Allow writes
   * to devices" is off, and its annotations have to say `destructiveHint`.
   */
  writesToDevice?: boolean
  run: (
    input: z.objectOutputType<Shape, z.ZodTypeAny>,
    context: McpToolContext
  ) => Promise<CallToolResult>
}

/** A tool with its argument type erased, so a group is a plain array. */
export interface McpTool {
  name: string
  title: string
  description: string
  inputSchema: ZodRawShape
  annotations: ToolAnnotations
  writesToDevice: boolean
  /** Parse `input` against the schema and run the tool, guards included. */
  call: (input: unknown, context: McpToolContext) => Promise<CallToolResult>
}

/** A text result holding `value` as JSON. */
export const toolResult = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }]
})

/** A result the client is told is a failure, saying why. */
export const toolError = (message: string): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: message }]
})

export const MAIN_WINDOW_CLOSED =
  'The Modbux main window is not open. MCP works only while it is; open Modbux and try again.'

export const WRITES_NOT_ALLOWED =
  'Writing to devices is switched off. The user can allow it in Modbux under Settings, "Allow writes to devices".'

/**
 * One tool, ready for `registerTools`.
 *
 * The SDK checks the arguments against `inputSchema` before it calls a tool,
 * and `call` checks them again, so a tool called straight from a test meets
 * the same schema a client does.
 */
export const defineTool = <Shape extends ZodRawShape>(
  definition: ToolDefinition<Shape>
): McpTool => {
  const schema = z.object(definition.inputSchema)
  const writesToDevice = definition.writesToDevice ?? false

  if (writesToDevice && definition.annotations.destructiveHint !== true) {
    throw new Error(`${definition.name} writes to a device and does not say destructiveHint`)
  }

  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    inputSchema: definition.inputSchema,
    annotations: definition.annotations,
    writesToDevice,
    call: async (input, context): Promise<CallToolResult> => {
      if (!context.mainWindowOpen()) return toolError(MAIN_WINDOW_CLOSED)
      if (writesToDevice && !context.allowWrites()) return toolError(WRITES_NOT_ALLOWED)

      const parsed = schema.safeParse(input ?? {})
      if (!parsed.success) return toolError(`Invalid arguments: ${parsed.error.message}`)

      try {
        return await definition.run(parsed.data, context)
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error))
      }
    }
  }
}

/** Put every tool of every group on `server`. */
export const registerTools = (
  server: McpServer,
  groups: readonly (readonly McpTool[])[],
  context: McpToolContext
): void => {
  for (const tool of groups.flat()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { title: tool.title, ...tool.annotations }
      },
      (input) => tool.call(input, context)
    )
  }
}
