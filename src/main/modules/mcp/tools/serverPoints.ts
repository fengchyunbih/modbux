import z from 'zod'
import {
  acceptedPoints,
  AddressNotationSchema,
  byteOrderFlags,
  ByteOrder,
  ByteOrderSchema,
  createRegisters,
  createStringRegisters,
  engineeringToRaw,
  PointAddressSchema,
  PointInterpolationSchema,
  PortSchema,
  RegisterParams,
  RegisterType,
  reorderBytes,
  resolveAddress,
  ServerPointSchema,
  ServerRegisters,
  ServerSummary,
  ServerValues,
  ServerValueWrite,
  serverUnitsOf,
  toExact64Bits,
  UnitIdSchema,
  UnitIdStringSchema,
  validatePointTable,
  registerWidth
} from '@shared'
import { defineTool, McpTool, McpToolContext, toolError, toolResult } from '../registry'
import { commandFailure } from './commandFailure'

/**
 * The server tools that hold a point table: the Modbus servers in the main
 * window, which an MCP client sets up as simulators.
 *
 * Every change goes through the main window's server store as a renderer
 * command and is one undo step there. The commands refuse while the server
 * view is split out, because the main window's server store is stale then.
 */

/** How a tool names the server it is about. */
const TARGET_INPUT = {
  uuid: z.string().min(1).optional().describe('The server, by the uuid server_list answers'),
  port: PortSchema.optional().describe('The server, by the TCP port it listens on')
}

const describeServers = (servers: readonly ServerSummary[]): string =>
  servers
    .map(({ uuid, port, name }) => `${uuid} (port ${port}${name ? `, ${name}` : ''})`)
    .join(', ')

/** The server `target` names, or why it names none. */
const findServer = async (
  context: McpToolContext,
  target: { uuid?: string; port?: number }
): Promise<ServerSummary | string> => {
  const { servers } = await context.rendererCommands.send('server_list')
  if (target.uuid === undefined && target.port === undefined) {
    return `Name the server by uuid or port. The servers are: ${describeServers(servers)}`
  }
  const server = servers.find(
    ({ uuid, port }) =>
      (target.uuid === undefined || uuid === target.uuid) &&
      (target.port === undefined || port === String(target.port))
  )
  if (server) return server
  const named = [
    target.uuid === undefined ? undefined : `uuid ${target.uuid}`,
    target.port === undefined ? undefined : `port ${target.port}`
  ]
    .filter((part) => part !== undefined)
    .join(' and ')
  return `No server has ${named}. The servers are: ${describeServers(servers)}`
}

/** Runs `run` on the server the input names, answering a failure as a tool error. */
const onServer = async (
  context: McpToolContext,
  target: { uuid?: string; port?: number },
  run: (server: ServerSummary) => Promise<ReturnType<typeof toolResult>>
): Promise<ReturnType<typeof toolResult>> => {
  try {
    const server = await findServer(context, target)
    if (typeof server === 'string') return toolError(server)
    return await run(server)
  } catch (error) {
    return toolError(commandFailure(error))
  }
}

//
//
// server_apply_point_table

const serverApplyPointTable = defineTool({
  name: 'server_apply_point_table',
  title: 'Apply a point table to a server',
  description:
    'Set up a Modbux server as a simulator of a point table. Each point gets its address (pdu0, one_based or modicon notation), data type, name/unit/comment, and either a fixed engineering value or a generator range in engineering units; the raw value is computed by the inverse of the scaling factor and interpolation, and refused when it does not fit the data type. On apply, the registers of each unit the table names are replaced and the table byte order is applied to the server, as one undo step. Every point is answered accepted or rejected with the reason; only accepted points are applied. dryRun answers the report and changes nothing. The server is named by uuid or port.',
  inputSchema: {
    ...TARGET_INPUT,
    unitId: UnitIdSchema.optional().describe(
      "The unit the points go to. Default: the unit the server's view shows"
    ),
    points: z.array(ServerPointSchema).min(1).max(10000),
    notation: AddressNotationSchema.default('pdu0'),
    byteOrder: ByteOrderSchema.optional().describe(
      'The byte order of the whole table. Without it, the first 32 or 64 bit point that names one sets it'
    ),
    dryRun: z.boolean().default(false)
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false
  },
  run: (input, context) =>
    onServer(context, input, async (server) => {
      const report = validatePointTable(input.points, {
        target: 'server',
        notation: input.notation,
        byteOrder: input.byteOrder,
        unitId: input.unitId ?? Number(server.unitId)
      })
      const points = acceptedPoints(report)
      const target = { uuid: server.uuid, port: server.port }
      if (input.dryRun) return toolResult({ dryRun: true, applied: false, server: target, report })
      if (points.length === 0) {
        return { ...toolResult({ applied: false, server: target, report }), isError: true }
      }

      const units = serverUnitsOf(points)
      const values = await context.rendererCommands.send('server_apply_point_table', {
        uuid: server.uuid,
        units,
        byteOrder: report.byteOrder
      })
      return toolResult({
        applied: true,
        server: target,
        byteOrder: values.byteOrder,
        unitIds: Object.keys(units).map(Number),
        report
      })
    })
})

//
//
// server_get_values

/** The words a 64 bit integer holds, which a JS number cannot carry exactly. */
const exact64BitWords = (
  dataType: 'int64' | 'uint64',
  value: number | string,
  order: ByteOrder
): number[] | undefined => {
  const composite = toExact64Bits(value)
  if (composite === undefined) return undefined
  const buffer = Buffer.alloc(8)
  if (dataType === 'int64') buffer.writeBigInt64BE(composite)
  else buffer.writeBigUInt64BE(composite)
  const ordered = Buffer.from(reorderBytes(buffer, byteOrderFlags(order)))
  return [0, 2, 4, 6].map((offset) => ordered.readUInt16BE(offset))
}

/** The words a register puts on the wire, in the server's byte order. */
const wordsOf = (
  params: RegisterParams,
  value: number | string,
  order: ByteOrder
): number[] | undefined => {
  const { dataType } = params
  switch (dataType) {
    case 'none':
      return undefined
    case 'utf8':
      return createStringRegisters(params.stringValue ?? '', registerWidth('utf8', params.length))
    case 'int64':
    case 'uint64':
      return exact64BitWords(dataType, value, order)
    default:
      return createRegisters(dataType, Number(value), byteOrderFlags(order))
  }
}

/** One register as `server_get_values` answers it. */
interface ServerRegisterRow {
  registerType: RegisterType
  address: number
  comment?: string
  dataType?: string
  /** What the register holds now: the raw value, decoded in the server's byte order. */
  value: number | string | boolean
  /** The 16 bit words the server answers a read with. */
  words?: number[]
  generator?: { min: number; max: number; intervalMs: number }
}

const rowsOf = (registers: ServerRegisters, order: ByteOrder): ServerRegisterRow[] => {
  const rows: ServerRegisterRow[] = []
  for (const registerType of ['coils', 'discrete_inputs'] as const) {
    for (const [address, entry] of Object.entries(registers[registerType])) {
      rows.push({
        registerType,
        address: Number(address),
        value: entry.value,
        ...(entry.comment ? { comment: entry.comment } : {})
      })
    }
  }
  for (const registerType of ['input_registers', 'holding_registers'] as const) {
    for (const [address, { value, params }] of Object.entries(registers[registerType])) {
      const words = wordsOf(params, value, order)
      rows.push({
        registerType,
        address: Number(address),
        dataType: params.dataType,
        ...(params.comment ? { comment: params.comment } : {}),
        value: params.dataType === 'utf8' ? (params.stringValue ?? '') : value,
        ...(words ? { words } : {}),
        ...(params.min !== undefined && params.max !== undefined && params.interval !== undefined
          ? { generator: { min: params.min, max: params.max, intervalMs: params.interval } }
          : {})
      })
    }
  }
  return rows.sort((a, b) =>
    a.registerType === b.registerType
      ? a.address - b.address
      : a.registerType.localeCompare(b.registerType)
  )
}

const serverGetValues = defineTool({
  name: 'server_get_values',
  title: 'Get the values of a server',
  description:
    "What a Modbux server holds, per unit: every coil and discrete input with its bit, and every input and holding register with its data type, comment, its raw value (decoded in the server's byte order), the 16 bit words a master reads, and its generator where one drives it. The server is named by uuid or port; unitId narrows it to one unit.",
  inputSchema: { ...TARGET_INPUT, unitId: UnitIdSchema.optional() },
  annotations: { readOnlyHint: true, openWorldHint: false },
  run: (input, context) =>
    onServer(context, input, async (server) => {
      const values = await context.rendererCommands.send('server_get_values', {
        uuid: server.uuid
      })
      const units = Object.entries(values.units)
        .filter(([unitId]) => input.unitId === undefined || unitId === String(input.unitId))
        .flatMap(([unitId, registers]) =>
          registers
            ? [{ unitId: Number(unitId), registers: rowsOf(registers, values.byteOrder) }]
            : []
        )
        .sort((a, b) => a.unitId - b.unitId)
      return toolResult({
        uuid: values.uuid,
        port: values.port,
        byteOrder: values.byteOrder,
        units
      })
    })
})

//
//
// server_set_values

const ValueInputSchema = z.object({
  address: PointAddressSchema,
  notation: AddressNotationSchema.optional(),
  registerType: z
    .enum(['coils', 'discrete_inputs', 'input_registers', 'holding_registers'])
    .optional(),
  value: z
    .union([z.number(), z.boolean(), z.string()])
    .describe('The engineering value; a boolean for a bit, a string for utf8'),
  scalingFactor: z.number().optional(),
  interpolate: PointInterpolationSchema.optional(),
  unitId: UnitIdSchema.optional()
})
type ValueInput = z.infer<typeof ValueInputSchema>

interface ValueReport {
  index: number
  status: 'accepted' | 'rejected'
  reason?: string
  unitId?: number
  registerType?: RegisterType
  address?: number
  dataType?: string
  raw?: number | boolean | string
}

/** The register a value lands on and the raw value it writes, or why it lands on none. */
const resolveValue = (
  value: ValueInput,
  defaults: { notation: z.infer<typeof AddressNotationSchema>; unitId: number },
  current: ServerValues
): { write: ServerValueWrite; dataType?: string } | string => {
  const address = resolveAddress(
    value.address,
    value.notation ?? defaults.notation,
    value.registerType
  )
  if (!address.ok) return address.reason
  const unitNumber = value.unitId ?? defaults.unitId
  const unitId = UnitIdStringSchema.parse(String(unitNumber))
  const unit = current.units[unitId]
  const { registerType } = address
  const write = { unitId, registerType, address: address.address }

  if (registerType === 'coils' || registerType === 'discrete_inputs') {
    if (!unit?.[registerType][address.address]) {
      return `Unit ${unitNumber} has no ${registerType} entry at ${address.address}; apply a point table to add one`
    }
    if (typeof value.value !== 'boolean') return `A ${registerType} value is true or false`
    return { write: { ...write, value: value.value } }
  }

  const entry = unit?.[registerType][address.address]
  if (!entry) {
    const under = Object.values(unit?.[registerType] ?? {}).find(
      ({ params }) =>
        params.address < address.address &&
        address.address < params.address + registerWidth(params.dataType, params.length)
    )
    return under
      ? `${registerType} ${address.address} is inside the ${under.params.dataType} at ${under.params.address}`
      : `Unit ${unitNumber} has no ${registerType} register at ${address.address}; apply a point table to add one`
  }
  const { dataType, length } = entry.params
  if (entry.params.min !== undefined) {
    return `The register at ${address.address} is driven by a generator; apply a point table to fix its value`
  }
  if (dataType === 'utf8') {
    if (typeof value.value !== 'string') return 'A utf8 value is a string'
    const width = registerWidth('utf8', length)
    const bytes = new TextEncoder().encode(value.value).length
    if (bytes > width * 2)
      return `"${value.value}" is ${bytes} bytes, and ${width} registers hold ${width * 2}`
    return { write: { ...write, value: value.value }, dataType }
  }
  if (typeof value.value !== 'number') return `A ${dataType} value is a number`
  const raw = engineeringToRaw(value.value, dataType, {
    scalingFactor: value.scalingFactor,
    interpolate: value.interpolate
  })
  if (!raw.ok) return raw.reason
  return { write: { ...write, value: raw.raw }, dataType }
}

/** Why the store did not take a value main had resolved. */
const SET_REFUSALS = {
  no_register: 'The register was removed before the value arrived',
  generator: 'A generator drives this register now',
  refused: 'Modbux refused the register'
} as const

const serverSetValues = defineTool({
  name: 'server_set_values',
  title: 'Set values on a server',
  description:
    "Write engineering values into registers a Modbux server already holds (add them with server_apply_point_table). The address is in pdu0 (default), one_based or modicon notation; the raw value is computed from the register's own data type and the scalingFactor and interpolate given, and refused when it does not fit. A coil or discrete input takes a boolean; a register a generator drives is refused. One undo step. dryRun answers the report and changes nothing.",
  inputSchema: {
    ...TARGET_INPUT,
    unitId: UnitIdSchema.optional().describe(
      "The unit of every value that names none. Default: the unit the server's view shows"
    ),
    notation: AddressNotationSchema.default('pdu0'),
    values: z.array(ValueInputSchema).min(1).max(10000),
    dryRun: z.boolean().default(false)
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false
  },
  run: (input, context) =>
    onServer(context, input, async (server) => {
      const current = await context.rendererCommands.send('server_get_values', {
        uuid: server.uuid
      })
      const defaults = { notation: input.notation, unitId: input.unitId ?? Number(server.unitId) }
      const writes: { report: ValueReport; write: ServerValueWrite }[] = []
      const reports = input.values.map((value, index): ValueReport => {
        const resolved = resolveValue(value, defaults, current)
        if (typeof resolved === 'string') return { index, status: 'rejected', reason: resolved }
        const report: ValueReport = {
          index,
          status: 'accepted',
          unitId: Number(resolved.write.unitId),
          registerType: resolved.write.registerType,
          address: resolved.write.address,
          ...(resolved.dataType ? { dataType: resolved.dataType } : {}),
          raw: resolved.write.value
        }
        writes.push({ report, write: resolved.write })
        return report
      })
      const target = { uuid: server.uuid, port: server.port }
      const summary = (): Record<string, unknown> => {
        const accepted = reports.filter((report) => report.status === 'accepted').length
        return { server: target, accepted, rejected: reports.length - accepted, values: reports }
      }

      if (input.dryRun) return toolResult({ dryRun: true, applied: false, ...summary() })
      if (writes.length === 0)
        return { ...toolResult({ applied: false, ...summary() }), isError: true }

      const { results } = await context.rendererCommands.send('server_set_values', {
        uuid: server.uuid,
        values: writes.map(({ write }) => write)
      })
      // The answer holds one result per value sent, in order; a value past the
      // end of a shorter one is one the window never said it set.
      for (const [position, { report }] of writes.entries()) {
        const result = results[position]
        if (result === 'set') continue
        report.status = 'rejected'
        report.reason =
          result === undefined ? 'Modbux did not answer for this value' : SET_REFUSALS[result]
      }
      return toolResult({ applied: true, ...summary() })
    })
})

/** The server point table tools, in the order a client lists them. */
export const serverPointTools: readonly McpTool[] = [
  serverApplyPointTable,
  serverSetValues,
  serverGetValues
]
