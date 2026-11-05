import z from 'zod'
import {
  ByteOrder,
  ByteOrderSchema,
  DataType,
  DataTypeSchema,
  isBooleanRegister,
  MAX_REGISTER_ADDRESS,
  RegisterMapping,
  RegisterMapValue,
  RegisterParams,
  RegisterParamsSchema,
  RegisterType,
  RegisterTypeSchema,
  scalableDataTypes,
  ServerRegisters,
  UnitIdSchema,
  UnitIdString,
  UnitIdStringSchema
} from './types'
import {
  createRegisters,
  getMinMaxValues,
  getValueRangeError,
  holdsExact64Bits,
  MAX_UTF8_LENGTH,
  registerWidth,
  ServerRegisterValue
} from './encoding'
import { emptyRegisterMapping } from './default'

//
//
// A point table, as an MCP client hands one over
//
// `docs/design/json-config-and-mcp.md`, MCP 介面草案: the tool does the
// deterministic conversions, an address notation to a PDU address and an
// engineering value to a raw one, and answers every point accepted or rejected
// with the reason. 已知限制 lists what a table can ask for that one Modbux
// configuration cannot hold; each of those is a rejected point here.

/**
 * How a table writes its addresses.
 *
 * - `pdu0`: the address on the wire, 0 to 65535.
 * - `one_based`: the PDU address plus one, 1 to 65536.
 * - `modicon`: a leading digit naming the register type (0 coils, 1 discrete
 *   inputs, 3 input registers, 4 holding registers) and a one based offset
 *   after it, in five digits (offset 1 to 9999, 40001 is holding register 0)
 *   or six (offset 1 to 65536, 400001 is holding register 0).
 */
export const AddressNotationSchema = z.enum(['pdu0', 'one_based', 'modicon'])
export type AddressNotation = z.infer<typeof AddressNotationSchema>

/**
 * An address as a table writes it.
 *
 * A string of digits as well as a number, because a five digit modicon coil
 * address starts with a zero that a number cannot keep. A number in modicon
 * notation is read as if padded with zeros to five digits, or to six when it is
 * 100000 or more.
 */
export const PointAddressSchema = z.union([z.number().int(), z.string().regex(/^\d+$/)])
export type PointAddress = z.infer<typeof PointAddressSchema>

/**
 * A linear interpolation over the scaled value, as numbers.
 *
 * The client mapping stores its endpoints as the strings a user typed
 * (`RegisterLinearInterpolationSchema`); the table takes numbers and the
 * mapping gets their strings.
 */
export const PointInterpolationSchema = z.object({
  x1: z.number(),
  x2: z.number(),
  y1: z.number(),
  y2: z.number()
})
export type PointInterpolation = z.infer<typeof PointInterpolationSchema>

/**
 * One row of a point table.
 *
 * `dataType` is a string rather than `DataTypeSchema`, so a type Modbux does
 * not know rejects that point and not the whole call.
 */
export const PointSchema = z.object({
  name: z.string().min(1).describe('The point name, which becomes the comment'),
  address: PointAddressSchema.describe('The address in the notation the table uses'),
  notation: AddressNotationSchema.optional().describe(
    "Overrides the table's notation for this point"
  ),
  registerType: RegisterTypeSchema.optional().describe(
    'Needed for pdu0 and one_based; implied by a modicon address'
  ),
  dataType: z
    .string()
    .optional()
    .describe(
      'int16, uint16, int32, uint32, int64, uint64, float, double, unix, datetime, utf8 or bitmap. Omitted for coils and discrete inputs'
    ),
  byteOrder: ByteOrderSchema.optional().describe(
    'ABCD, CDAB, BADC or DCBA. One table holds one byte order'
  ),
  scalingFactor: z
    .number()
    .optional()
    .describe('Engineering value = raw value times this, then interpolated'),
  interpolate: PointInterpolationSchema.optional().describe(
    'A line through (x1, y1) and (x2, y2) read at the scaled value'
  ),
  length: z
    .number()
    .int()
    .min(1)
    .max(MAX_UTF8_LENGTH)
    .optional()
    .describe('The width of a utf8 point in registers'),
  unit: z.string().optional().describe('The engineering unit, kept in the comment'),
  comment: z.string().optional(),
  unitId: UnitIdSchema.optional().describe("Overrides the table's unit id for this point")
})
export type Point = z.infer<typeof PointSchema>

/**
 * What a simulated point varies between, in engineering units, and how often.
 *
 * A `unix` or `datetime` generator reads the clock, so it takes no range.
 */
export const PointGeneratorSchema = z.object({
  min: z.number().optional(),
  max: z.number().optional(),
  intervalSeconds: z.number().int().min(1).max(2147483).optional()
})
export type PointGenerator = z.infer<typeof PointGeneratorSchema>

/** A point a server simulates: a fixed engineering value, or a generator. */
export const ServerPointSchema = PointSchema.extend({
  value: z
    .union([z.number(), z.boolean(), z.string()])
    .optional()
    .describe(
      'The fixed engineering value: a number, a boolean for coils and discrete inputs, a string for utf8. Absent with no generator is raw 0 (or false)'
    ),
  generator: PointGeneratorSchema.optional().describe(
    'A range the value is drawn from, in engineering units, instead of a fixed value'
  )
})
export type ServerPoint = z.infer<typeof ServerPointSchema>

//
//
// Addresses

export type AddressResolution =
  | { ok: true; registerType: RegisterType; address: number }
  | { ok: false; reason: string }

const MODICON_PREFIXES: Partial<Record<string, RegisterType>> = {
  '0': 'coils',
  '1': 'discrete_inputs',
  '3': 'input_registers',
  '4': 'holding_registers'
}

/** The digits a modicon address is written in, or undefined for one that has none. */
const modiconDigits = (address: PointAddress): string | undefined => {
  if (typeof address === 'string') return address
  if (address < 0) return undefined
  if (address <= 99999) return String(address).padStart(5, '0')
  if (address <= 999999) return String(address).padStart(6, '0')
  return undefined
}

const resolveModicon = (
  address: PointAddress,
  registerType: RegisterType | undefined
): AddressResolution => {
  const digits = modiconDigits(address)
  if (digits === undefined || (digits.length !== 5 && digits.length !== 6)) {
    return { ok: false, reason: `Modicon address ${address} is not five or six digits` }
  }
  const implied = MODICON_PREFIXES[digits.slice(0, 1)]
  if (!implied) {
    return {
      ok: false,
      reason: `Modicon address ${digits} starts with ${digits.slice(0, 1)}, which names no register type (0, 1, 3 or 4)`
    }
  }
  if (registerType !== undefined && registerType !== implied) {
    return {
      ok: false,
      reason: `Modicon address ${digits} is ${implied}, and the point says ${registerType}`
    }
  }
  const offset = Number(digits.slice(1))
  const highest = digits.length === 5 ? 9999 : MAX_REGISTER_ADDRESS + 1
  if (offset < 1 || offset > highest) {
    return {
      ok: false,
      reason: `Modicon address ${digits} has offset ${offset}, outside 1 to ${highest}`
    }
  }
  return { ok: true, registerType: implied, address: offset - 1 }
}

/**
 * The register type and PDU address a table's address names, or why it names
 * none.
 *
 * `registerType` is required for `pdu0` and `one_based`, and has to agree with
 * the prefix of a `modicon` address when it is given.
 */
export const resolveAddress = (
  address: PointAddress,
  notation: AddressNotation,
  registerType?: RegisterType
): AddressResolution => {
  if (notation === 'modicon') return resolveModicon(address, registerType)

  if (registerType === undefined) {
    return { ok: false, reason: `A ${notation} address needs a registerType` }
  }
  const number = Number(address)
  const base = notation === 'one_based' ? 1 : 0
  const pdu = number - base
  if (pdu < 0 || pdu > MAX_REGISTER_ADDRESS) {
    return {
      ok: false,
      reason: `${notation} address ${address} is outside ${base} to ${MAX_REGISTER_ADDRESS + base}`
    }
  }
  return { ok: true, registerType, address: pdu }
}

//
//
// Engineering values

export interface PointScaling {
  scalingFactor?: number
  interpolate?: PointInterpolation
}

export type RawConversion = { ok: true; raw: number } | { ok: false; reason: string }

/** The largest finite float32, which `writeFloatBE` turns anything above into Infinity. */
const FLOAT32_MAX = 3.4028234663852886e38

/** The types whose raw value is a whole number. */
const WHOLE_NUMBER_TYPES: readonly DataType[] = [
  'int16',
  'uint16',
  'int32',
  'uint32',
  'int64',
  'uint64',
  'bitmap',
  'unix',
  'datetime'
]

/**
 * How far a quotient may sit from a whole number and still be one: dividing
 * 230.5 by 0.1 answers 2304.9999999999995.
 */
const isWhole = (value: number): boolean =>
  Math.abs(value - Math.round(value)) <= 1e-9 * Math.max(1, Math.abs(value))

/** Whether a scaling says anything: a factor other than 1, or an interpolation. */
const scales = ({ scalingFactor, interpolate }: PointScaling): boolean =>
  (scalingFactor !== undefined && scalingFactor !== 1) || interpolate !== undefined

/**
 * The raw value whose engineering value is `value`, by the inverse of
 * `scaleValue` (`engineeringValue.ts`), or why there is none.
 *
 * `scaleValue` multiplies by the factor and then interpolates, so this undoes
 * the interpolation and then divides. The raw value has to be one the data
 * type holds: whole for an integer type, within its range, and finite. A
 * quotient that is not whole is refused rather than rounded, because the
 * engineering value read back would not be the one asked for.
 *
 * `unix` is seconds and `datetime` milliseconds, the units the server stores,
 * and neither takes a scaling, because `scaleValue` is not applied to them.
 */
export const engineeringToRaw = (
  value: number,
  dataType: DataType,
  scaling: PointScaling = {}
): RawConversion => {
  if (dataType === 'none' || dataType === 'utf8') {
    return { ok: false, reason: `A ${dataType} point holds no number` }
  }
  if (!Number.isFinite(value)) return { ok: false, reason: `${value} is not a finite number` }
  if (!scalableDataTypes.includes(dataType) && scales(scaling)) {
    return {
      ok: false,
      reason: `A scaling factor or interpolation applies to ${scalableDataTypes.join(', ')}, not ${dataType}`
    }
  }

  let scaled = value
  const { interpolate } = scaling
  if (interpolate) {
    const { x1, x2, y1, y2 } = interpolate
    if (x1 === x2 || y1 === y2) {
      return {
        ok: false,
        reason: 'The interpolation answers one value everywhere, so no raw value maps back'
      }
    }
    scaled = x1 + ((value - y1) * (x2 - x1)) / (y2 - y1)
  }

  const factor = scaling.scalingFactor ?? 1
  if (factor === 0) return { ok: false, reason: 'A scaling factor of 0 maps every raw value to 0' }
  let raw = scaled / factor

  if (WHOLE_NUMBER_TYPES.includes(dataType)) {
    if (!isWhole(raw)) {
      return {
        ok: false,
        reason: `Engineering value ${value} is raw ${raw}, and a ${dataType} holds whole numbers`
      }
    }
    // `+ 0` turns a -0 into 0, which `writeUInt16BE` takes and JSON prints the same.
    raw = Math.round(raw) + 0
  }

  if (dataType === 'float' && Math.abs(raw) > FLOAT32_MAX) {
    return { ok: false, reason: `Raw value ${raw} is beyond what a float holds` }
  }

  const rangeError = getValueRangeError(dataType, raw)
  if (rangeError) return { ok: false, reason: `Raw value ${raw}: ${rangeError}` }
  if (dataType === 'unix' || dataType === 'datetime') {
    const { min, max } = getMinMaxValues(dataType)
    if (raw < min || raw > max) {
      return { ok: false, reason: `A ${dataType} value has to be between ${min} and ${max}` }
    }
  }

  return { ok: true, raw }
}

//
//
// Validation

/** The 32 and 64 bit types, which are the ones a byte order applies to. */
const WIDE_TYPES: readonly DataType[] = [
  'int32',
  'uint32',
  'float',
  'unix',
  'int64',
  'uint64',
  'double',
  'datetime'
]

const swapsBytes = (order: ByteOrder): boolean => order === 'BADC' || order === 'DCBA'

/** A generator as the server stores it, in raw values and milliseconds. */
export interface ResolvedGenerator {
  min: number
  max: number
  intervalMs: number
}

/** What an accepted point is, once the table's notation and scaling are taken out. */
export interface ResolvedPoint {
  unitId: number
  registerType: RegisterType
  /** The PDU address. */
  address: number
  /** How many registers (or bits) the point occupies. */
  width: number
  dataType?: Exclude<DataType, 'none'>
  byteOrder?: ByteOrder
  scalingFactor?: number
  interpolate?: PointInterpolation
  /** What the comment column gets: the name, the unit and the comment. */
  comment: string
  /** A server point's fixed raw value: a number, a bit, or a utf8 string. */
  raw?: number | boolean | string
  generator?: ResolvedGenerator
}

export interface PointReport {
  index: number
  name: string
  status: 'accepted' | 'rejected'
  reason?: string
  /** Present for an accepted point, and for a rejected one whose address resolved. */
  resolved?: ResolvedPoint
}

export interface PointTableReport {
  /** The byte order the table applies to the configuration, or none it named. */
  byteOrder?: ByteOrder
  /** The unit id a client table applies, or none it named. */
  unitId?: number
  accepted: number
  rejected: number
  points: PointReport[]
}

export interface PointTableOptions {
  target: 'client' | 'server'
  /** The notation of every point that does not name its own. Default `pdu0`. */
  notation?: AddressNotation
  /** The table's byte order. Without one, the first 32 or 64 bit point that names one sets it. */
  byteOrder?: ByteOrder
  /**
   * The table's unit id. A client table without one takes the first point's
   * that names one; a server point without one goes to this unit.
   */
  unitId?: number
}

/** The comment a point becomes: `name [unit] comment`. */
export const pointComment = (point: Pick<Point, 'name' | 'unit' | 'comment'>): string =>
  [point.name, point.unit ? `[${point.unit}]` : undefined, point.comment || undefined]
    .filter((part) => part !== undefined)
    .join(' ')

type PointCheck = { ok: true; resolved: ResolvedPoint } | { ok: false; reason: string }

const reject = (reason: string): { ok: false; reason: string } => ({ ok: false, reason })

/** The data type a point names, or why it names none Modbux has. */
const pointDataType = (
  point: Point,
  registerType: RegisterType
): { ok: true; dataType?: Exclude<DataType, 'none'> } | { ok: false; reason: string } => {
  if (isBooleanRegister(registerType)) {
    if (point.dataType === undefined || point.dataType === 'bool') return { ok: true }
    return reject(`A ${registerType} point holds one bit; give it no dataType (or bool)`)
  }
  if (point.dataType === undefined) return reject(`A ${registerType} point needs a dataType`)
  const parsed = DataTypeSchema.safeParse(point.dataType)
  if (!parsed.success || parsed.data === 'none') {
    return reject(`Data type ${point.dataType} is unknown`)
  }
  return { ok: true, dataType: parsed.data }
}

/** The server half of a point: its fixed raw value, or its generator in raw values. */
const serverValue = (
  point: ServerPoint,
  resolved: ResolvedPoint
):
  | { ok: true; raw?: ResolvedPoint['raw']; generator?: ResolvedGenerator }
  | {
      ok: false
      reason: string
    } => {
  const { value, generator } = point
  if (value !== undefined && generator !== undefined) {
    return reject('A point takes a fixed value or a generator, not both')
  }

  if (isBooleanRegister(resolved.registerType)) {
    if (generator !== undefined) return reject(`A ${resolved.registerType} point has no generator`)
    if (value === undefined) return { ok: true, raw: false }
    if (typeof value !== 'boolean')
      return reject(`A ${resolved.registerType} value is true or false`)
    return { ok: true, raw: value }
  }

  const dataType = resolved.dataType ?? 'none'
  if (dataType === 'utf8') {
    if (generator !== undefined) return reject('A utf8 point has no generator')
    const text = value ?? ''
    if (typeof text !== 'string') return reject('A utf8 value is a string')
    const bytes = new TextEncoder().encode(text).length
    if (bytes > resolved.width * 2) {
      return reject(
        `"${text}" is ${bytes} bytes, and ${resolved.width} registers hold ${resolved.width * 2}`
      )
    }
    return { ok: true, raw: text }
  }

  const scaling = { scalingFactor: point.scalingFactor, interpolate: point.interpolate }

  if (generator !== undefined) {
    const intervalMs = (generator.intervalSeconds ?? 1) * 1000
    // A timestamp generator reads the clock, and the store pins its range to 0.
    if (dataType === 'unix' || dataType === 'datetime') {
      if (generator.min !== undefined || generator.max !== undefined) {
        return reject(`A ${dataType} generator reads the clock and takes no min or max`)
      }
      return { ok: true, generator: { min: 0, max: 0, intervalMs } }
    }
    if (generator.min === undefined || generator.max === undefined) {
      return reject('A generator needs a min and a max')
    }
    const min = engineeringToRaw(generator.min, dataType, scaling)
    if (!min.ok) return reject(`Generator min: ${min.reason}`)
    const max = engineeringToRaw(generator.max, dataType, scaling)
    if (!max.ok) return reject(`Generator max: ${max.reason}`)
    // A negative factor turns the range around, and the generator draws the
    // same range either way, so it is stored lowest first.
    return {
      ok: true,
      generator: { min: Math.min(min.raw, max.raw), max: Math.max(min.raw, max.raw), intervalMs }
    }
  }

  if (value === undefined) return { ok: true, raw: 0 }
  if (typeof value !== 'number') return reject(`A ${dataType} value is a number`)
  const raw = engineeringToRaw(value, dataType, scaling)
  return raw.ok ? { ok: true, raw: raw.raw } : raw
}

/** Everything about one point that the points around it have no say in. */
const checkPoint = (
  point: Point | ServerPoint,
  options: PointTableOptions
): PointCheck | { ok: false; reason: string; resolved: ResolvedPoint } => {
  const notation = point.notation ?? options.notation ?? 'pdu0'
  const address = resolveAddress(point.address, notation, point.registerType)
  if (!address.ok) return address

  const dataType = pointDataType(point, address.registerType)
  if (!dataType.ok) return dataType

  const width = dataType.dataType
    ? registerWidth(dataType.dataType, dataType.dataType === 'utf8' ? point.length : undefined)
    : 1
  const resolved: ResolvedPoint = {
    unitId: point.unitId ?? options.unitId ?? 0,
    registerType: address.registerType,
    address: address.address,
    width,
    comment: pointComment(point)
  }
  if (dataType.dataType) resolved.dataType = dataType.dataType
  const failing = (reason: string): { ok: false; reason: string; resolved: ResolvedPoint } => ({
    ok: false,
    reason,
    resolved
  })

  if (address.address + width - 1 > MAX_REGISTER_ADDRESS) {
    return failing(`${width} registers from ${address.address} run past ${MAX_REGISTER_ADDRESS}`)
  }

  const wide = dataType.dataType !== undefined && WIDE_TYPES.includes(dataType.dataType)
  if (point.byteOrder !== undefined && swapsBytes(point.byteOrder) && !wide) {
    return failing(
      `Byte order ${point.byteOrder} swaps bytes, which applies to 32 and 64 bit types, not ${dataType.dataType ?? address.registerType}`
    )
  }
  // A 16 bit type reads the same in every order, so only a wide point's says anything.
  if (wide && point.byteOrder !== undefined) resolved.byteOrder = point.byteOrder

  if (point.scalingFactor !== undefined || point.interpolate !== undefined) {
    if (!dataType.dataType || !scalableDataTypes.includes(dataType.dataType)) {
      if (scales(point)) {
        return failing(
          `A scaling factor or interpolation applies to ${scalableDataTypes.join(', ')}, not ${dataType.dataType ?? address.registerType}`
        )
      }
    } else {
      if (point.scalingFactor === 0)
        return failing('A scaling factor of 0 maps every raw value to 0')
      if (point.scalingFactor !== undefined) resolved.scalingFactor = point.scalingFactor
      if (point.interpolate !== undefined) resolved.interpolate = point.interpolate
    }
  }

  if (options.target === 'server') {
    const value = serverValue(point, resolved)
    if (!value.ok) return failing(value.reason)
    if (value.raw !== undefined) resolved.raw = value.raw
    if (value.generator !== undefined) resolved.generator = value.generator

    const params = serverRegisterParams(resolved)
    if (params) {
      const parsed = RegisterParamsSchema.safeParse(params)
      if (!parsed.success) {
        return failing(parsed.error.issues.map((issue) => issue.message).join('; '))
      }
    }
  }

  return { ok: true, resolved }
}

/** The span of addresses a point occupies, half open. */
const spanOf = ({ address, width }: ResolvedPoint): [number, number] => [address, address + width]

/**
 * Every point of a table, accepted or rejected with the reason.
 *
 * A point is checked on its own first: its address and notation, its data
 * type, its width against the end of the map, a byte swap on a type it does
 * not apply to, its scaling, and on a server its value. Then, in table order,
 * against the points accepted before it: a byte order other than the table's,
 * a client point under another unit id than the table's, and a span that
 * overlaps one already accepted on the same register type. On a server the
 * overlap is per unit; a client reads one unit id, so its points overlap
 * whatever unit id each names. A rejected point sets nothing for the points
 * after it, and every accepted client point reports the unit id the table
 * applies.
 */
export const validatePointTable = (
  points: readonly (Point | ServerPoint)[],
  options: PointTableOptions
): PointTableReport => {
  let byteOrder = options.byteOrder
  let unitId = options.target === 'client' ? options.unitId : undefined
  const accepted: { name: string; resolved: ResolvedPoint }[] = []

  const reports = points.map((point, index): PointReport => {
    const check = checkPoint(point, options)
    const report = (reason?: string, resolved?: ResolvedPoint): PointReport => ({
      index,
      name: point.name,
      status: reason === undefined ? 'accepted' : 'rejected',
      ...(reason === undefined ? {} : { reason }),
      ...(resolved ? { resolved } : {})
    })
    if (!check.ok) return report(check.reason, 'resolved' in check ? check.resolved : undefined)
    const { resolved } = check

    if (resolved.byteOrder !== undefined) {
      if (byteOrder !== undefined && resolved.byteOrder !== byteOrder) {
        return report(
          `Byte order ${resolved.byteOrder} differs from the table's ${byteOrder}; one configuration has one byte order`,
          resolved
        )
      }
    }

    if (options.target === 'client' && point.unitId !== undefined) {
      if (unitId !== undefined && point.unitId !== unitId) {
        return report(
          `Unit id ${point.unitId} differs from the table's ${unitId}; one client configuration reads one unit id`,
          resolved
        )
      }
    }

    const [start, end] = spanOf(resolved)
    const overlapping = accepted.find(
      (other) =>
        (options.target === 'client' || other.resolved.unitId === resolved.unitId) &&
        other.resolved.registerType === resolved.registerType &&
        start < spanOf(other.resolved)[1] &&
        spanOf(other.resolved)[0] < end
    )
    if (overlapping) {
      return report(
        `${resolved.registerType} ${start} to ${end - 1} overlaps "${overlapping.name}" at ${overlapping.resolved.address}`,
        resolved
      )
    }

    if (resolved.byteOrder !== undefined) byteOrder = resolved.byteOrder
    if (options.target === 'client' && point.unitId !== undefined) unitId = point.unitId
    accepted.push({ name: point.name, resolved })
    return report(undefined, resolved)
  })

  if (options.target === 'client' && unitId !== undefined) {
    for (const { resolved } of accepted) resolved.unitId = unitId
  }

  const acceptedCount = reports.filter((report) => report.status === 'accepted').length
  const table: PointTableReport = {
    accepted: acceptedCount,
    rejected: reports.length - acceptedCount,
    points: reports
  }
  if (byteOrder !== undefined) table.byteOrder = byteOrder
  if (unitId !== undefined) table.unitId = unitId
  return table
}

/** The resolved points a report accepted, in table order. */
export const acceptedPoints = (report: PointTableReport): ResolvedPoint[] =>
  report.points.flatMap((point) =>
    point.status === 'accepted' && point.resolved ? [point.resolved] : []
  )

//
//
// What an accepted table becomes

/** The client register mapping an accepted table describes, and nothing else. */
export const clientMappingOf = (points: readonly ResolvedPoint[]): RegisterMapping => {
  const mapping = emptyRegisterMapping()
  for (const point of points) {
    const entry: RegisterMapValue = { comment: point.comment }
    if (point.dataType) entry.dataType = point.dataType
    if (point.dataType === 'utf8') entry.length = point.width
    if (point.scalingFactor !== undefined) entry.scalingFactor = point.scalingFactor
    if (point.interpolate) {
      const { x1, x2, y1, y2 } = point.interpolate
      entry.interpolate = { x1: String(x1), x2: String(x2), y1: String(y1), y2: String(y2) }
    }
    mapping[point.registerType][point.address] = entry
  }
  return mapping
}

/** The register type, address and length a client reads to cover a table. */
export interface ReadWindow {
  type: RegisterType
  address: number
  length: number
}

/**
 * The window over the first accepted point's register type, from its lowest
 * address to the end of its widest reach. Points of the other types are mapped
 * and lie outside it; `otherTypes` names them.
 */
export const readWindowOf = (
  points: readonly ResolvedPoint[]
): { window: ReadWindow; otherTypes: RegisterType[] } | undefined => {
  const [first] = points
  if (!first) return undefined
  const type = first.registerType
  const ofType = points.filter((point) => point.registerType === type)
  const address = Math.min(...ofType.map((point) => point.address))
  const end = Math.max(...ofType.map((point) => point.address + point.width))
  const otherTypes = [...new Set(points.map((point) => point.registerType))].filter(
    (other) => other !== type
  )
  return { window: { type, address, length: end - address }, otherTypes }
}

/** The params a server stores for an accepted register point, or none for a bit. */
export const serverRegisterParams = (point: ResolvedPoint): RegisterParams | undefined => {
  const { registerType, dataType } = point
  if (registerType !== 'input_registers' && registerType !== 'holding_registers') return undefined
  if (!dataType) return undefined
  const base = { address: point.address, registerType, dataType, comment: point.comment }

  if (dataType === 'utf8') {
    return {
      ...base,
      value: 0,
      stringValue: typeof point.raw === 'string' ? point.raw : '',
      length: point.width
    }
  }
  if (point.generator) {
    const { min, max, intervalMs } = point.generator
    return { ...base, min, max, interval: intervalMs }
  }
  return { ...base, value: typeof point.raw === 'number' ? point.raw : 0 }
}

/**
 * What a register entry holds before main's words reach it, in the meaning
 * `foldWordIntoComposite` gives it: a datetime is its four words in ABCD packed
 * into 64 bits, not the milliseconds they encode.
 */
const initialValue = (params: RegisterParams): ServerRegisterValue => {
  const { value, dataType } = params
  if (value === undefined || dataType === 'utf8' || dataType === 'none') return 0
  if (dataType === 'datetime') {
    const words = createRegisters(dataType, value, { littleEndian: false, byteSwap: false })
    return String(words.reduce((packed, word) => (packed << 16n) | BigInt(word), 0n))
  }
  return holdsExact64Bits(dataType) ? String(value) : value
}

/** An empty unit, the four maps a server keeps per unit id. */
const emptyUnit = (): ServerRegisters => ({
  coils: {},
  discrete_inputs: {},
  input_registers: {},
  holding_registers: {}
})

/**
 * What each unit an accepted server table names holds, keyed by unit id.
 *
 * A fixed register holds its raw value from the start, as the decimal string
 * `ServerRegisterValue` keeps for a 64 bit integer, because the words main
 * answers reach the store on a batching timer and a read before it fired
 * answered 0. A generated or utf8 register holds 0 until those words arrive.
 * A bit holds the table's value.
 */
export const serverUnitsOf = (
  points: readonly ResolvedPoint[]
): Partial<Record<UnitIdString, ServerRegisters>> => {
  const units: Partial<Record<UnitIdString, ServerRegisters>> = {}
  for (const point of points) {
    const unitId = UnitIdStringSchema.parse(String(point.unitId))
    const unit = units[unitId] ?? emptyUnit()
    units[unitId] = unit
    const params = serverRegisterParams(point)
    if (params) {
      const value = initialValue(params)
      if (params.registerType === 'input_registers') {
        unit.input_registers[point.address] = { value, params }
      } else {
        unit.holding_registers[point.address] = { value, params }
      }
      continue
    }
    if (point.registerType === 'coils' || point.registerType === 'discrete_inputs') {
      unit[point.registerType][point.address] = {
        value: point.raw === true,
        ...(point.comment ? { comment: point.comment } : {})
      }
    }
  }
  return units
}
