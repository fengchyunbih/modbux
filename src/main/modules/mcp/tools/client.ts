import { byteOrderOf, clientOwner, engineeringValue, RegisterData, RegisterType } from '@shared'
import type { ReadOutcome } from '../../modbusClient'
import { RendererCommandError } from '../../rendererCommands'
import { defineTool, McpTool, McpToolContext, toolError, toolResult } from '../registry'

/**
 * The client tools: the Modbus client in the main window, which is the one
 * connection Modbux has to a device.
 *
 * The configuration lives in the main window's stores, so a tool that reads or
 * changes it goes through `rendererCommands`; a tool that talks to the device
 * calls main's `ModbusClient` (`docs/design/json-config-and-mcp.md`, 架構決策).
 */

/** The message a failed renderer command becomes. */
const commandFailure = (error: unknown): string => {
  if (error instanceof RendererCommandError) return error.message
  return error instanceof Error ? error.message : String(error)
}

const connectState = (context: McpToolContext): string => context.client.state.connectState

//
//
// client_get_config

const clientGetConfig = defineTool({
  name: 'client_get_config',
  title: 'Get the client configuration',
  description:
    'The Modbus client configuration as the Modbux window holds it: connection (protocol, host, port, unit id, serial settings), register config (register type, address, length, address base, byte order), the register mapping per register type (data type, scaling factor, comment, interpolation per PDU address), whether read configuration is on, and the current connect state.',
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: false },
  run: async (_input, context) => {
    try {
      const config = await context.rendererCommands.send('client_get_config')
      return toolResult({ ...config, connectState: connectState(context) })
    } catch (error) {
      return toolError(commandFailure(error))
    }
  }
})

//
//
// client_connect

const CONNECT_REFUSALS = {
  no_address:
    'The client has no host (TCP) or COM port (RTU) set. Set the connection in Modbux first.',
  serial_access_blocked:
    'This user may not open serial ports. Modbux shows a dialog that explains the fix; connect again after it.'
} as const

const clientConnect = defineTool({
  name: 'client_connect',
  title: 'Connect the client',
  description:
    'Connect the Modbus client with the connection settings it holds, the way the Connect button does. Answers the connect state once the attempt has finished, or an error with the reason it did not connect. Already connected is not an error.',
  inputSchema: {},
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true
  },
  run: async (_input, context) => {
    if (connectState(context) === 'connected') {
      return toolResult({ connectState: 'connected', message: 'Already connected' })
    }

    const answer = await context.rendererCommands
      .send('client_connect')
      .catch((error: unknown) => commandFailure(error))
    if (typeof answer === 'string') return toolError(answer)
    const { outcome } = answer

    if (outcome === 'not_disconnected') {
      return toolError(
        `The client is ${connectState(context)}; wait for it to finish, then try again.`
      )
    }
    if (outcome !== 'requested') return toolError(CONNECT_REFUSALS[outcome])

    const state = connectState(context)
    if (state === 'connected') return toolResult({ connectState: state })
    const reason = context.client.lastConnectError ?? 'the connect did not finish'
    return toolError(`Not connected (${state}): ${reason}`)
  }
})

//
//
// client_disconnect

const clientDisconnect = defineTool({
  name: 'client_disconnect',
  title: 'Disconnect the client',
  description:
    'Disconnect the Modbus client, or cancel a connect that is still opening, the way the Disconnect button does. Already disconnected is not an error.',
  inputSchema: {},
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true
  },
  run: async (_input, context) => {
    if (connectState(context) === 'disconnected') {
      return toolResult({ connectState: 'disconnected', message: 'Already disconnected' })
    }
    try {
      const { outcome } = await context.rendererCommands.send('client_disconnect')
      if (outcome === 'not_connected') {
        return toolError(
          `The client is ${connectState(context)}; wait for it to finish, then try again.`
        )
      }
    } catch (error) {
      return toolError(commandFailure(error))
    }
    return toolResult({ connectState: connectState(context) })
  }
})

//
//
// client_read_points

/** Why a read put nothing on the wire, or brought back nothing to answer. */
const READ_REFUSALS: Record<Extract<ReadOutcome, { read: false }>['reason'], string> = {
  busy: 'The client is busy with another request. Try again once it has finished.',
  not_connected: 'The client is not connected. Call client_connect first.',
  superseded:
    'The client configuration changed while the read was on the wire, so its values describe a configuration that is gone. Read again.'
}

const BIT_TYPES: readonly RegisterType[] = ['coils', 'discrete_inputs']

/** One row as `client_read_points` answers it. */
interface PointRow {
  /** The PDU address, which is what goes on the wire. */
  address: number
  /** The address as the Modbux grid shows it, with the address base added. */
  displayAddress: number
  /** The 16-bit word at this address, for a register type. */
  word?: number
  /** The same word as four hex digits, as the grid's Hex column shows it. */
  hex?: string
  /** The bit, for coils and discrete inputs. */
  bit?: boolean
  dataType?: string
  scalingFactor?: number
  comment?: string
  /**
   * What the grid's Value column shows: the data type decoded from this word
   * and the ones after it, in the client's byte order, then scaled.
   */
  value?: number | string
  error?: string
}

const pointRow = (
  row: RegisterData,
  type: RegisterType,
  addressBase: number,
  context: McpToolContext,
  groups: Extract<ReadOutcome, { read: true }>['groups']
): PointRow => {
  const map = context.appState.registerMapping?.[type] ?? {}
  const mapValue = map[row.id]
  const point: PointRow = { address: row.id, displayAddress: row.id + addressBase }

  if (BIT_TYPES.includes(type)) point.bit = row.bit
  else if (row.words) {
    point.word = row.words.uint16
    point.hex = row.hex
  }

  if (mapValue?.dataType && mapValue.dataType !== 'none') point.dataType = mapValue.dataType
  if (mapValue?.scalingFactor !== undefined) point.scalingFactor = mapValue.scalingFactor
  if (mapValue?.comment) point.comment = mapValue.comment

  const value = engineeringValue(row, map, groups, false)
  if (value !== undefined) point.value = value
  if (row.error) point.error = row.error
  return point
}

const clientReadPoints = defineTool({
  name: 'client_read_points',
  title: 'Read the client points',
  description:
    'Read once from the connected device and answer every address read, with the raw 16-bit word (or the bit), and for each address the mapping gives a data type: its comment, scaling factor and the engineering value as the Modbux grid shows it. With read configuration on, the mapped addresses are read; otherwise the register type, address and length the client is set to. Compare the words with the expected value to check the byte order and scaling.',
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: true },
  run: async (_input, context) => {
    const state = context.client.state
    if (state.connectState !== 'connected') return toolError(READ_REFUSALS.not_connected)
    const owner = clientOwner(state)
    if (owner) return toolError(`Cannot read during ${owner}. Try again once it has finished.`)

    // Read before the read goes out. A change to the type or the unit id
    // while it is out answers `superseded` rather than rows.
    const { registerConfig } = context.appState
    const { type, addressBase } = registerConfig
    const byteOrder = byteOrderOf(registerConfig)
    const { unitId } = context.appState.connectionConfig

    const outcome = await context.client.read()
    if (!outcome.read) return toolError(READ_REFUSALS[outcome.reason])

    const base = Number(addressBase)
    const rows = outcome.data
      .slice()
      .sort((a, b) => a.id - b.id)
      .map((row) => pointRow(row, type, base, context, outcome.groups))
    const errors = outcome.errors.map(({ group: [address, length], message }) => ({
      address,
      length,
      message
    }))

    const answer = {
      unitId,
      registerType: type,
      addressBase: base,
      byteOrder,
      readConfiguration: context.appState.readConfiguration,
      rows,
      errors
    }
    // Every group failed: nothing was read, and the result says why.
    if (errors.length > 0 && errors.length === outcome.groups.length) {
      return { ...toolResult(answer), isError: true }
    }
    return toolResult(answer)
  }
})

/** The client tools this step ships, in the order a client lists them. */
export const clientTools: readonly McpTool[] = [
  clientGetConfig,
  clientConnect,
  clientDisconnect,
  clientReadPoints
]
