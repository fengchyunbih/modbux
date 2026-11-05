import z from 'zod'
import {
  acceptedPoints,
  AddressNotationSchema,
  byteOrderFlags,
  byteOrderOf,
  ByteOrderSchema,
  ClientSetConnectionPayloadSchema,
  clientMappingOf,
  clientOwner,
  createRegisters,
  DataTypeSchema,
  engineeringToRaw,
  engineeringValue,
  MAX_REGISTER_ADDRESS,
  MAX_WRITE_BITS,
  PointAddressSchema,
  PointInterpolationSchema,
  PointSchema,
  readWindowOf,
  RegisterData,
  RegisterMapValue,
  registerWidth,
  RegisterType,
  resolveAddress,
  UnitIdSchema,
  validatePointTable
} from '@shared'
import type { RawWriteRequest, ReadOutcome, WriteOutcome } from '../../modbusClient'
import { commandFailure } from './commandFailure'
import { defineTool, McpTool, McpToolContext, toolError, toolResult } from '../registry'

/**
 * The client tools: the Modbus client in the main window, which is the one
 * connection Modbux has to a device.
 *
 * The configuration lives in the main window's stores, so a tool that reads or
 * changes it goes through `rendererCommands`; a tool that talks to the device
 * calls main's `ModbusClient` (`docs/design/json-config-and-mcp.md`, 架構決策).
 */

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
   * and the ones after it, in the client's byte order, then scaled. An
   * unscaled int64 or uint64 is its decimal string, because a double holds
   * integers exactly only up to 2^53.
   */
  value?: number | string
  error?: string
}

/** An int64 or uint64 the mapping neither scales nor interpolates, exactly. */
const exactInteger = (
  row: RegisterData,
  mapValue: RegisterMapValue | undefined
): string | undefined => {
  const dataType = mapValue?.dataType
  if (dataType !== 'int64' && dataType !== 'uint64') return undefined
  if ((mapValue?.scalingFactor ?? 1) !== 1 || mapValue?.interpolate) return undefined
  if (row.error) return undefined
  return row.words?.[dataType].toString()
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

  const value = exactInteger(row, mapValue) ?? engineeringValue(row, map, groups, false)
  if (value !== undefined) point.value = value
  if (row.error) point.error = row.error
  return point
}

/**
 * The mapped addresses of `type` the read brought back no row for, ascending.
 * A register address counts where its data type is one to read; a coil or a
 * discrete input counts by being mapped, because a bit carries no data type.
 */
const unreadAddresses = (
  context: McpToolContext,
  type: RegisterType,
  rows: readonly PointRow[]
): number[] => {
  const read = new Set(rows.map((row) => row.address))
  const map = context.appState.registerMapping?.[type] ?? {}
  return Object.entries(map)
    .filter(([, entry]) =>
      BIT_TYPES.includes(type)
        ? entry !== undefined
        : !!entry?.dataType && entry.dataType !== 'none'
    )
    .map(([address]) => Number(address))
    .filter((address) => !read.has(address))
    .sort((a, b) => a - b)
}

const clientReadPoints = defineTool({
  name: 'client_read_points',
  title: 'Read the client points',
  description:
    'Read once from the connected device and answer every address read, with the raw 16-bit word (or the bit), and for each address the mapping gives a data type: its comment, scaling factor and the engineering value as the Modbux grid shows it. An unscaled int64 or uint64 value is a decimal string, so it keeps every digit. With read configuration on, the mapped addresses are read; otherwise the register type, address and length the client is set to, at most 125 registers or 2000 bits. `unread` names the mapped addresses of the register type that got no row. Compare the words with the expected value to check the byte order and scaling.',
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
      unread: unreadAddresses(context, type, rows),
      errors
    }
    // Every group failed: nothing was read, and the result says why.
    if (errors.length > 0 && errors.length === outcome.groups.length) {
      return { ...toolResult(answer), isError: true }
    }
    return toolResult(answer)
  }
})

//
//
// Point table tools: the connection, a point table and a write

//
//
// client_set_connection

const CLIENT_WRITE_REFUSALS = {
  'refused-connected':
    'The client is connected, and these settings change the connection. Call client_disconnect first.',
  refused: 'Modbux refused a setting, so the configuration before it is kept.'
} as const

const clientSetConnection = defineTool({
  name: 'client_set_connection',
  title: 'Set the client connection',
  description:
    'Change the connection the client opens: protocol (ModbusTcp, ModbusRtu, ModbusRtuOverTcp), unitId, tcp.host and tcp.options.port, or rtu.com and rtu.options (baudRate, parity, dataBits, stopBits). Fields left out keep their value. Refused while connected if it changes anything but the unit id. One undo step in Modbux.',
  inputSchema: ClientSetConnectionPayloadSchema.shape,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  },
  run: async (input, context) => {
    try {
      const { outcome, connectionConfig } = await context.rendererCommands.send(
        'client_set_connection',
        input
      )
      if (outcome !== 'done') return toolError(CLIENT_WRITE_REFUSALS[outcome])
      return toolResult({ connectionConfig, connectState: connectState(context) })
    } catch (error) {
      return toolError(commandFailure(error))
    }
  }
})

//
//
// client_apply_point_table

const clientApplyPointTable = defineTool({
  name: 'client_apply_point_table',
  title: 'Apply a point table to the client',
  description:
    "Map a device's point table onto the client: each point's address (in pdu0, one_based or modicon notation) is converted to a PDU address and register type, and its data type, scaling factor, interpolation and name/unit/comment become the register mapping. On apply, the mapping is replaced, the read window (register type, address, length) is set to cover the points of the first point's register type, and the table's byte order and unit id are set, as one undo step. Read configuration is switched on for a register type, so client_read_points reads every mapped point of that type. Every point is answered accepted or rejected with the reason; only accepted points are applied. Rejected: unknown data type, address out of range, overlapping points, a byte order that differs from the table's (one configuration has one byte order), a byte swap (BADC, DCBA) on a 16 bit type or utf8, a unit id other than the table's. dryRun answers the report and changes nothing.",
  inputSchema: {
    points: z.array(PointSchema).min(1).max(10000),
    notation: AddressNotationSchema.default('pdu0').describe(
      'The notation of every point that does not name its own'
    ),
    byteOrder: ByteOrderSchema.optional().describe(
      'The byte order of the whole table. Without it, the first 32 or 64 bit point that names one sets it'
    ),
    unitId: UnitIdSchema.optional().describe('The unit id the client reads'),
    dryRun: z.boolean().default(false)
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false
  },
  run: async (input, context) => {
    const report = validatePointTable(input.points, {
      target: 'client',
      notation: input.notation,
      byteOrder: input.byteOrder,
      unitId: input.unitId
    })
    const points = acceptedPoints(report)
    const covered = readWindowOf(points)

    if (input.dryRun) {
      return toolResult({ dryRun: true, applied: false, ...covered, report })
    }
    if (!covered) {
      return { ...toolResult({ applied: false, report }), isError: true }
    }

    try {
      const result = await context.rendererCommands.send('client_apply_point_table', {
        registerMapping: clientMappingOf(points),
        window: covered.window,
        byteOrder: report.byteOrder,
        unitId: report.unitId
      })
      if (result.outcome !== 'done') return toolError(CLIENT_WRITE_REFUSALS[result.outcome])
      return toolResult({
        applied: true,
        byteOrder: byteOrderOf(result.registerConfig),
        unitId: result.unitId,
        ...covered,
        report
      })
    } catch (error) {
      return toolError(commandFailure(error))
    }
  }
})

//
//
// client_write

/** What `client_write` says about a write that went nowhere. */
const WRITE_REFUSALS: Record<Extract<WriteOutcome, { written: false }>['reason'], string> = {
  not_connected: 'The client is not connected. Call client_connect first.',
  busy: 'The client is busy with another request. Try again once it has finished.',
  refused: 'Modbux refused the write before it went out; the window says why.'
}

/** The largest FC16 carries 123 registers. */
const MAX_WRITE_REGISTERS = 123

const CLIENT_WRITE_INPUT = {
  address: PointAddressSchema,
  notation: AddressNotationSchema.default('pdu0'),
  registerType: z.enum(['coils', 'holding_registers']).optional(),
  coils: z.array(z.boolean()).min(1).max(MAX_WRITE_BITS).optional(),
  value: z.number().optional().describe('The engineering value, for holding registers'),
  dataType: z.string().optional(),
  byteOrder: ByteOrderSchema.optional(),
  scalingFactor: z.number().optional(),
  interpolate: PointInterpolationSchema.optional(),
  words: z.array(z.number().int().min(0).max(0xffff)).min(1).max(MAX_WRITE_REGISTERS).optional(),
  single: z.boolean().default(false)
}
type ClientWriteInput = z.infer<z.ZodObject<typeof CLIENT_WRITE_INPUT>>

const clientWrite = defineTool({
  name: 'client_write',
  title: 'Write to the device',
  description:
    "Write coils or holding registers on the connected device, the way the Modbux write dialog does, then read back. The address is in pdu0 (default), one_based or modicon notation. For coils give `coils` (a list of booleans). For holding registers give either `value` with `dataType` (and optionally byteOrder, default the client's; scalingFactor and interpolate, so value is the engineering value and the raw value is computed), or `words` (raw 16 bit words, written as given). `single` uses FC5/FC6 (one coil or one word) instead of FC15/FC16. Answers the words or bits written. Needs writes allowed in Modbux's settings.",
  inputSchema: CLIENT_WRITE_INPUT,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true
  },
  writesToDevice: true,
  run: async (input, context) => {
    const request = clientWriteRequest(input, context)
    if (typeof request === 'string') return toolError(request)
    if (context.client.state.connectState !== 'connected') {
      return toolError(WRITE_REFUSALS.not_connected)
    }

    const outcome = await context.client.writeRaw(request.write)
    if (!outcome.written) return toolError(WRITE_REFUSALS[outcome.reason])
    const answer = {
      registerType: request.write.type,
      address: request.write.address,
      unitId: context.appState.connectionConfig.unitId,
      ...(request.write.type === 'coils'
        ? { coils: request.write.values }
        : { words: request.write.words }),
      ...request.encoded
    }
    if (outcome.error !== undefined) {
      return { ...toolResult({ ...answer, error: outcome.error }), isError: true }
    }
    return toolResult(answer)
  }
})

/** How a value became words, which the answer repeats so the caller can check it. */
interface EncodedValue {
  dataType?: string
  byteOrder?: string
  raw?: number
}

/**
 * The write `client_write` asks for, or why it asks for none.
 *
 * The value is encoded here, in the byte order asked for, so the client's own
 * order only decides the default.
 */
function clientWriteRequest(
  input: ClientWriteInput,
  context: McpToolContext
): { write: RawWriteRequest; encoded: EncodedValue } | string {
  const address = resolveAddress(input.address, input.notation, input.registerType)
  if (!address.ok) return address.reason
  const { registerType } = address
  if (registerType !== 'coils' && registerType !== 'holding_registers') {
    return `${registerType} are read only; write coils or holding_registers`
  }
  const end = (width: number): string | undefined =>
    address.address + width - 1 > MAX_REGISTER_ADDRESS
      ? `${width} from ${address.address} run past ${MAX_REGISTER_ADDRESS}`
      : undefined

  if (registerType === 'coils') {
    if (!input.coils) return 'A coil write takes `coils`, a list of booleans'
    if (input.value !== undefined || input.words !== undefined) {
      return 'A coil write takes `coils`, not `value` or `words`'
    }
    if (input.single && input.coils.length !== 1) return 'A single coil write carries one coil'
    const pastEnd = end(input.coils.length)
    if (pastEnd) return pastEnd
    return {
      write: { type: 'coils', address: address.address, values: input.coils, single: input.single },
      encoded: {}
    }
  }

  if (input.coils) return 'A holding register write takes `value` or `words`, not `coils`'
  if (input.value !== undefined && input.words !== undefined) {
    return 'A holding register write takes either `value` with `dataType`, or `words`'
  }

  let words: number[]
  let encoded: EncodedValue = {}
  if (input.words) {
    words = input.words
  } else if (input.value !== undefined) {
    if (input.dataType === undefined) return 'A `value` needs a `dataType`'
    const parsed = DataTypeSchema.safeParse(input.dataType)
    if (!parsed.success) return `Data type ${input.dataType} is unknown`
    const dataType = parsed.data
    if (dataType === 'none' || dataType === 'utf8') {
      return `Modbux writes no ${dataType} value; write the string's words instead`
    }
    const order = input.byteOrder ?? byteOrderOf(context.appState.registerConfig)
    // A byte swap asked for on a 16 bit type is refused, as in a point table;
    // the client's own order, taken by default, says nothing about one.
    const swaps = input.byteOrder === 'BADC' || input.byteOrder === 'DCBA'
    if (swaps && registerWidth(dataType) === 1) {
      return `Byte order ${order} swaps bytes, which applies to 32 and 64 bit types, not ${dataType}`
    }
    const raw = engineeringToRaw(input.value, dataType, {
      scalingFactor: input.scalingFactor,
      interpolate: input.interpolate
    })
    if (!raw.ok) return raw.reason
    words = createRegisters(dataType, raw.raw, byteOrderFlags(order))
    encoded = { dataType, byteOrder: order, raw: raw.raw }
  } else {
    return 'A holding register write takes either `value` with `dataType`, or `words`'
  }

  if (input.single && words.length !== 1) return 'A single register write carries one word'
  const pastEnd = end(words.length)
  if (pastEnd) return pastEnd
  return {
    write: { type: 'holding_registers', address: address.address, words, single: input.single },
    encoded
  }
}

/** The client tools, in the order a client lists them. */
export const clientTools: readonly McpTool[] = [
  clientGetConfig,
  clientConnect,
  clientDisconnect,
  clientReadPoints,
  // Point table tools
  clientSetConnection,
  clientApplyPointTable,
  clientWrite
]
