import z from 'zod'
import {
  clientOwner,
  MAX_REGISTER_ADDRESS,
  MAX_UNIT_ID,
  RegisterData,
  RegisterType,
  RegisterTypeSchema,
  ScanRegistersParametersSchema,
  ScanUnitIDParametersSchema
} from '@shared'
import { defineTool, McpTool, McpToolContext, toolError, toolResult } from '../registry'

/**
 * The scan tools: the two scans the client has, as one call that answers what
 * the scan found.
 *
 * Both go through `ModbusClient.scanRegisters` and `scanUnitIds`, the code the
 * scan dialogs use, so the window shows the same progress and rows while the
 * agent waits. A scan is slow, so each tool has a bound on the range and a
 * deadline after which it stops the scan and answers what it has.
 */

/** The most addresses one `client_scan_registers` call covers. */
export const MAX_SCAN_ADDRESSES = 10000
/** The most requests one `client_scan_unit_ids` call sends: unit ids times register types. */
export const MAX_SCAN_UNIT_REQUESTS = 1000
/** After this long a scan is stopped and answers what it found. */
export const SCAN_DEADLINE_MS = 120_000
/** The rows one answer carries. A scan that finds more says so. */
export const MAX_FOUND_ROWS = 2000

const TIMEOUT_MIN_MS = 100
const TIMEOUT_MAX_MS = 5000
const ERRORS_SHOWN = 10

const BIT_TYPES: readonly RegisterType[] = ['coils', 'discrete_inputs']

const timeoutField = z
  .number()
  .int()
  .min(TIMEOUT_MIN_MS)
  .max(TIMEOUT_MAX_MS)
  .default(500)
  .describe(
    `How long to wait for each request, in milliseconds (${TIMEOUT_MIN_MS} to ${TIMEOUT_MAX_MS}, default 500). An address or unit that does not answer costs this long.`
  )

/** Why a scan could not start. */
const refusal = (
  context: McpToolContext
): { error: string } | { connected: true; unitId: number } => {
  const { state } = context.client
  if (state.connectState !== 'connected') {
    return { error: 'The client is not connected. Call client_connect first.' }
  }
  const owner = clientOwner(state)
  if (owner) {
    return { error: `Cannot scan during ${owner}. Try again once it has finished.` }
  }
  return { connected: true, unitId: context.appState.connectionConfig.unitId }
}

/**
 * Run `scan`, and stop it with `stop` when the deadline passes.
 *
 * The stop makes the scan answer with `stopped: true`, so the caller still
 * gets what was found up to then.
 */
const withDeadline = async <T>(
  scan: () => Promise<T>,
  stop: () => void
): Promise<{ outcome: T; deadlineHit: boolean }> => {
  let deadlineHit = false
  const timer = setTimeout(() => {
    deadlineHit = true
    stop()
  }, SCAN_DEADLINE_MS)
  try {
    return { outcome: await scan(), deadlineHit }
  } finally {
    clearTimeout(timer)
  }
}

const SCAN_REFUSALS = {
  busy: 'The client is busy with another request. Try again once it has finished.',
  not_connected: 'The client is not connected. Call client_connect first.'
} as const

//
//
// client_scan_registers

interface FoundRow {
  /** The PDU address. */
  address: number
  /** The 16-bit word, for a register type. */
  word?: number
  hex?: string
  /** The bit, for coils and discrete inputs. */
  bit?: boolean
}

const foundRow = (row: RegisterData, type: RegisterType): FoundRow => {
  if (BIT_TYPES.includes(type)) return { address: row.id, bit: row.bit }
  return { address: row.id, word: row.words?.uint16, hex: row.hex }
}

const clientScanRegisters = defineTool({
  name: 'client_scan_registers',
  title: 'Scan the device for registers',
  description: `Scan a range of addresses on the connected device with the client's current unit id, and answer the addresses that hold a non-zero word (or a set bit) with their values. Use it to find where a device keeps data when there is no point table. A range of up to ${MAX_SCAN_ADDRESSES} addresses; the scan stops after ${SCAN_DEADLINE_MS / 1000} seconds and answers what it has found, with stopped: true. Addresses are PDU addresses (starting at 0). The Modbux window shows the scan as it runs. Refused while a poll, read, write or another scan is running.`,
  inputSchema: {
    registerType: RegisterTypeSchema.optional().describe(
      "The register type to scan. Without it, the client's current register type."
    ),
    startAddress: z
      .number()
      .int()
      .min(0)
      .max(MAX_REGISTER_ADDRESS)
      .describe('The first PDU address to scan.'),
    count: z
      .number()
      .int()
      .min(1)
      .max(MAX_SCAN_ADDRESSES)
      .describe(`How many addresses to scan, 1 to ${MAX_SCAN_ADDRESSES}.`),
    chunkSize: z
      .number()
      .int()
      .min(1)
      .default(100)
      .describe(
        'Addresses per request (default 100). A request is cut to what one read can carry: 125 registers or 2000 bits.'
      ),
    timeoutMs: timeoutField
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  run: async ({ registerType, startAddress, count, chunkSize, timeoutMs }, context) => {
    const last = startAddress + count - 1
    if (last > MAX_REGISTER_ADDRESS) {
      return toolError(
        `The range ends at ${last}, past the last address ${MAX_REGISTER_ADDRESS}. Lower startAddress or count.`
      )
    }

    const ready = refusal(context)
    if ('error' in ready) return toolError(ready.error)

    const parameters = ScanRegistersParametersSchema.safeParse({
      addressRange: [startAddress, last],
      length: Math.min(chunkSize, count),
      timeout: timeoutMs,
      registerType
    })
    if (!parameters.success) return toolError(`Invalid arguments: ${parameters.error.message}`)

    const type = registerType ?? context.appState.registerConfig.type
    const { outcome, deadlineHit } = await withDeadline(
      () => context.client.scanRegisters(parameters.data),
      () => context.client.stopScanningRegisters()
    )
    if (!outcome.scanned) return toolError(SCAN_REFUSALS[outcome.reason])

    // The last chunk can reach past the range, so rows beyond it are dropped.
    const found = outcome.found
      .filter((row) => row.id >= startAddress && row.id <= last)
      .slice()
      .sort((a, b) => a.id - b.id)
      .map((row) => foundRow(row, type))
    return toolResult({
      unitId: ready.unitId,
      registerType: type,
      range: [startAddress, last],
      foundCount: found.length,
      found: found.slice(0, MAX_FOUND_ROWS),
      truncated: found.length > MAX_FOUND_ROWS,
      stopped: outcome.stopped,
      ...(deadlineHit && { stoppedBy: `the ${SCAN_DEADLINE_MS / 1000} second deadline` }),
      failedChunks: outcome.errors.length,
      errors: outcome.errors.slice(0, ERRORS_SHOWN)
    })
  }
})

//
//
// client_scan_unit_ids

const clientScanUnitIds = defineTool({
  name: 'client_scan_unit_ids',
  title: 'Scan for unit ids',
  description: `Ask each unit id in a range for a few registers, and answer the units that replied. A unit that replied with data or with a Modbus exception is on the bus; silence means it is not. At most ${MAX_SCAN_UNIT_REQUESTS} requests per call (unit ids times register types), and the scan stops after ${SCAN_DEADLINE_MS / 1000} seconds and answers what it has, with stopped: true. The Modbux window shows the scan as it runs. Refused while a poll, read, write or another scan is running. The client's unit id setting is not changed.`,
  inputSchema: {
    startUnitId: z.number().int().min(0).max(MAX_UNIT_ID).describe('The first unit id to ask.'),
    endUnitId: z.number().int().min(0).max(MAX_UNIT_ID).describe('The last unit id to ask.'),
    registerTypes: z
      .array(RegisterTypeSchema)
      .min(1)
      .default(['holding_registers'])
      .describe('The register types to ask each unit for (default holding_registers).'),
    address: z
      .number()
      .int()
      .min(0)
      .max(MAX_REGISTER_ADDRESS)
      .default(0)
      .describe('The PDU address each request reads (default 0).'),
    length: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe('How many registers or bits each request reads (default 1).'),
    timeoutMs: timeoutField
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  run: async ({ startUnitId, endUnitId, registerTypes, address, length, timeoutMs }, context) => {
    if (endUnitId < startUnitId) {
      return toolError('endUnitId is below startUnitId.')
    }
    const requests = (endUnitId - startUnitId + 1) * registerTypes.length
    if (requests > MAX_SCAN_UNIT_REQUESTS) {
      return toolError(
        `That is ${requests} requests, over the limit of ${MAX_SCAN_UNIT_REQUESTS}. Scan fewer unit ids or register types per call.`
      )
    }

    const ready = refusal(context)
    if ('error' in ready) return toolError(ready.error)

    const parameters = ScanUnitIDParametersSchema.safeParse({
      range: [startUnitId, endUnitId],
      address,
      length,
      registerTypes,
      timeout: timeoutMs
    })
    if (!parameters.success) {
      return toolError(
        `Invalid arguments: ${parameters.error.issues.map((i) => i.message).join('; ')}`
      )
    }

    const { outcome, deadlineHit } = await withDeadline(
      () => context.client.scanUnitIds(parameters.data),
      () => context.client.stopScanningUnitIds()
    )
    if (!outcome.scanned) return toolError(SCAN_REFUSALS[outcome.reason])

    const replied = outcome.results
      .filter((result) => result.registerTypes.length > 0 || result.refusedRegisterTypes.length > 0)
      .map((result) => ({
        unitId: result.id,
        answeredWithData: result.registerTypes,
        answeredWithException: result.refusedRegisterTypes
      }))
    return toolResult({
      range: [startUnitId, endUnitId],
      registerTypes,
      address,
      length,
      unitsAsked: outcome.results.length,
      replied,
      stopped: outcome.stopped,
      ...(deadlineHit && { stoppedBy: `the ${SCAN_DEADLINE_MS / 1000} second deadline` }),
      configuredUnitId: ready.unitId
    })
  }
})

/** The scan tools, in the order a client lists them. */
export const scanTools: readonly McpTool[] = [clientScanRegisters, clientScanUnitIds]
