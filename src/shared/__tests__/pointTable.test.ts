import { describe, expect, it } from 'vitest'
import {
  acceptedPoints,
  clientMappingOf,
  engineeringToRaw,
  Point,
  pointComment,
  PointSchema,
  readWindowOf,
  resolveAddress,
  ServerPoint,
  serverRegisterParams,
  serverUnitsOf,
  validatePointTable
} from '../pointTable'
import { scaleValue } from '../engineeringValue'
import { DataType } from '../types'

const point = (fields: Partial<Point> & Pick<Point, 'address'>): Point => ({
  name: `P${fields.address}`,
  registerType: 'holding_registers',
  dataType: 'uint16',
  ...fields
})

const reasons = (report: ReturnType<typeof validatePointTable>): (string | undefined)[] =>
  report.points.map((entry) => entry.reason)

describe('resolveAddress', () => {
  it.each([
    ['pdu0', 0, 0],
    ['pdu0', 65535, 65535],
    ['pdu0', '17', 17],
    ['one_based', 1, 0],
    ['one_based', 65536, 65535],
    ['one_based', '100', 99]
  ] as const)('%s %s is PDU address %s', (notation, address, pdu) => {
    expect(resolveAddress(address, notation, 'input_registers')).toEqual({
      ok: true,
      registerType: 'input_registers',
      address: pdu
    })
  })

  it.each([
    ['pdu0', -1, 'pdu0 address -1 is outside 0 to 65535'],
    ['pdu0', 65536, 'pdu0 address 65536 is outside 0 to 65535'],
    ['one_based', 0, 'one_based address 0 is outside 1 to 65536'],
    ['one_based', 65537, 'one_based address 65537 is outside 1 to 65536']
  ] as const)('refuses %s %s', (notation, address, reason) => {
    expect(resolveAddress(address, notation, 'coils')).toEqual({ ok: false, reason })
  })

  it('refuses a pdu0 or one_based address with no register type', () => {
    expect(resolveAddress(3, 'pdu0')).toEqual({
      ok: false,
      reason: 'A pdu0 address needs a registerType'
    })
    expect(resolveAddress(3, 'one_based')).toEqual({
      ok: false,
      reason: 'A one_based address needs a registerType'
    })
  })

  describe('modicon', () => {
    it.each([
      ['00001', 'coils', 0],
      [1, 'coils', 0],
      ['09999', 'coils', 9998],
      [10001, 'discrete_inputs', 0],
      [30001, 'input_registers', 0],
      [39999, 'input_registers', 9998],
      [40001, 'holding_registers', 0],
      ['40100', 'holding_registers', 99],
      ['000001', 'coils', 0],
      [100001, 'discrete_inputs', 0],
      [300001, 'input_registers', 0],
      [400001, 'holding_registers', 0],
      [465536, 'holding_registers', 65535],
      ['065536', 'coils', 65535]
    ] as const)('%s is %s %s', (address, registerType, pdu) => {
      expect(resolveAddress(address, 'modicon')).toEqual({ ok: true, registerType, address: pdu })
    })

    it('takes a register type that agrees with the prefix', () => {
      expect(resolveAddress(40002, 'modicon', 'holding_registers')).toEqual({
        ok: true,
        registerType: 'holding_registers',
        address: 1
      })
    })

    it.each([
      [
        40001,
        'input_registers',
        'Modicon address 40001 is holding_registers, and the point says input_registers'
      ],
      [
        20001,
        undefined,
        'Modicon address 20001 starts with 2, which names no register type (0, 1, 3 or 4)'
      ],
      [
        50001,
        undefined,
        'Modicon address 50001 starts with 5, which names no register type (0, 1, 3 or 4)'
      ],
      [40000, undefined, 'Modicon address 40000 has offset 0, outside 1 to 9999'],
      [400000, undefined, 'Modicon address 400000 has offset 0, outside 1 to 65536'],
      [465537, undefined, 'Modicon address 465537 has offset 65537, outside 1 to 65536'],
      ['4001', undefined, 'Modicon address 4001 is not five or six digits'],
      ['4000001', undefined, 'Modicon address 4000001 is not five or six digits'],
      [1000000, undefined, 'Modicon address 1000000 is not five or six digits'],
      [-1, undefined, 'Modicon address -1 is not five or six digits']
    ] as const)('refuses %s', (address, registerType, reason) => {
      expect(resolveAddress(address, 'modicon', registerType)).toEqual({ ok: false, reason })
    })
  })
})

describe('engineeringToRaw', () => {
  it.each([
    ['int16', -32768, -32768],
    ['uint16', 65535, 65535],
    ['int32', -2147483648, -2147483648],
    ['uint32', 4294967295, 4294967295],
    ['int64', -9007199254740991, -9007199254740991],
    ['uint64', 9007199254740991, 9007199254740991],
    ['float', 1.5, 1.5],
    ['double', 1e300, 1e300],
    ['bitmap', 0xff00, 0xff00],
    ['unix', 1700000000, 1700000000],
    ['datetime', Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 1)]
  ] as const)('%s takes %s unscaled as %s', (dataType, value, raw) => {
    expect(engineeringToRaw(value, dataType)).toEqual({ ok: true, raw })
  })

  it.each([
    ['int16', 32768, 'Raw value 32768: A int16 value has to be between -32768 and 32767'],
    ['int16', -32769, 'Raw value -32769: A int16 value has to be between -32768 and 32767'],
    ['uint16', -1, 'Raw value -1: A uint16 value has to be between 0 and 65535'],
    ['uint16', 65536, 'Raw value 65536: A uint16 value has to be between 0 and 65535'],
    [
      'int32',
      2147483648,
      'Raw value 2147483648: A int32 value has to be between -2147483648 and 2147483647'
    ],
    [
      'uint32',
      4294967296,
      'Raw value 4294967296: A uint32 value has to be between 0 and 4294967295'
    ],
    ['uint64', -1, 'Raw value -1: A uint64 value has to be between 0 and 9007199254740991'],
    ['bitmap', 65536, 'Raw value 65536: A bitmap value has to be between 0 and 65535'],
    ['float', 1e39, 'Raw value 1e+39 is beyond what a float holds'],
    ['unix', -1, 'A unix value has to be between 0 and 4294967295'],
    ['datetime', 0, 'A datetime value has to be between 946684800000 and 4985971199999']
  ] as const)('refuses %s %s', (dataType, value, reason) => {
    expect(engineeringToRaw(value, dataType)).toEqual({ ok: false, reason })
  })

  it.each(['int16', 'uint16', 'int32', 'uint32', 'int64', 'uint64', 'bitmap', 'unix'] as const)(
    'refuses a fraction for %s',
    (dataType) => {
      expect(engineeringToRaw(1.5, dataType)).toEqual({
        ok: false,
        reason: `Engineering value 1.5 is raw 1.5, and a ${dataType} holds whole numbers`
      })
    }
  )

  it.each(['utf8', 'none'] as const)('refuses %s, which holds no number', (dataType) => {
    expect(engineeringToRaw(1, dataType)).toEqual({
      ok: false,
      reason: `A ${dataType} point holds no number`
    })
  })

  it.each([NaN, Infinity])('refuses %s', (value) => {
    expect(engineeringToRaw(value, 'double')).toEqual({
      ok: false,
      reason: `${value} is not a finite number`
    })
  })

  // `scaleValue` is what the client grid shows, so the raw value read back
  // through it has to give the engineering value asked for.
  it.each([
    ['int16', -12.3, 0.1, -123],
    ['uint16', 230.5, 0.1, 2305],
    ['int32', -123456, 1, -123456],
    ['uint32', 4000000.25, 0.01, 400000025],
    ['int64', 12.5, 0.5, 25],
    ['uint64', 1000, 10, 100],
    ['float', 230.5, 0.1, 2305],
    ['double', -1.25, 0.001, -1250]
  ] as const)(
    '%s at %s with factor %s is raw %s, and reads back',
    (dataType, value, factor, raw) => {
      const conversion = engineeringToRaw(value, dataType, { scalingFactor: factor })
      expect(conversion).toEqual({ ok: true, raw })
      expect(scaleValue(String(raw), dataType, { scalingFactor: factor })).toBe(value)
    }
  )

  it('undoes a negative factor', () => {
    expect(engineeringToRaw(-50, 'int16', { scalingFactor: -0.5 })).toEqual({ ok: true, raw: 100 })
  })

  it('refuses a value whose raw is no whole number under the factor', () => {
    expect(engineeringToRaw(230.05, 'uint16', { scalingFactor: 0.1 })).toEqual({
      ok: false,
      reason: 'Engineering value 230.05 is raw 2300.5, and a uint16 holds whole numbers'
    })
  })

  it('refuses a scaled raw value outside the type', () => {
    expect(engineeringToRaw(6553.6, 'uint16', { scalingFactor: 0.1 })).toEqual({
      ok: false,
      reason: 'Raw value 65536: A uint16 value has to be between 0 and 65535'
    })
  })

  it('refuses a factor of 0', () => {
    expect(engineeringToRaw(1, 'int16', { scalingFactor: 0 })).toEqual({
      ok: false,
      reason: 'A scaling factor of 0 maps every raw value to 0'
    })
  })

  it('undoes the interpolation, then the factor', () => {
    // 4 to 20 mA on 0 to 100 %, the raw word in tenths of a mA.
    const scaling = { scalingFactor: 0.1, interpolate: { x1: 4, x2: 20, y1: 0, y2: 100 } }
    const conversion = engineeringToRaw(50, 'uint16', scaling)

    expect(conversion).toEqual({ ok: true, raw: 120 })
    expect(
      scaleValue('120', 'uint16', {
        scalingFactor: 0.1,
        interpolate: { x1: '4', x2: '20', y1: '0', y2: '100' }
      })
    ).toBe(50)
  })

  it.each([[{ x1: 4, x2: 4, y1: 0, y2: 100 }], [{ x1: 4, x2: 20, y1: 7, y2: 7 }]])(
    'refuses an interpolation that answers one value everywhere',
    (interpolate) => {
      expect(engineeringToRaw(7, 'uint16', { interpolate })).toEqual({
        ok: false,
        reason: 'The interpolation answers one value everywhere, so no raw value maps back'
      })
    }
  )

  it.each(['bitmap', 'unix', 'datetime'] as const)('refuses a scaling on %s', (dataType) => {
    expect(engineeringToRaw(1, dataType, { scalingFactor: 2 })).toMatchObject({
      ok: false,
      reason: expect.stringContaining(`not ${dataType}`)
    })
  })

  it('takes a factor of 1 on a type that takes no scaling', () => {
    expect(engineeringToRaw(5, 'bitmap', { scalingFactor: 1 })).toEqual({ ok: true, raw: 5 })
  })
})

describe('pointComment', () => {
  it('joins the name, the unit and the comment', () => {
    expect(pointComment({ name: 'Voltage L1', unit: 'V', comment: 'phase to neutral' })).toBe(
      'Voltage L1 [V] phase to neutral'
    )
    expect(pointComment({ name: 'Status', comment: '' })).toBe('Status')
  })
})

describe('validatePointTable, one point at a time', () => {
  it('resolves an accepted point', () => {
    const report = validatePointTable(
      [
        {
          name: 'Voltage',
          address: 40001,
          dataType: 'float',
          byteOrder: 'CDAB',
          scalingFactor: 0.1,
          unit: 'V'
        }
      ],
      { target: 'client', notation: 'modicon' }
    )

    expect(report).toEqual({
      byteOrder: 'CDAB',
      accepted: 1,
      rejected: 0,
      points: [
        {
          index: 0,
          name: 'Voltage',
          status: 'accepted',
          resolved: {
            unitId: 0,
            registerType: 'holding_registers',
            address: 0,
            width: 2,
            dataType: 'float',
            byteOrder: 'CDAB',
            scalingFactor: 0.1,
            comment: 'Voltage [V]'
          }
        }
      ]
    })
  })

  it("takes a point's own notation over the table's", () => {
    const report = validatePointTable([point({ address: 40010, notation: 'modicon' })], {
      target: 'client',
      notation: 'one_based'
    })
    expect(report.points[0]?.resolved?.address).toBe(9)
  })

  it('rejects an unknown data type, and none', () => {
    const report = validatePointTable(
      [point({ address: 0, dataType: 'float32' }), point({ address: 1, dataType: 'none' })],
      { target: 'client' }
    )
    expect(reasons(report)).toEqual(['Data type float32 is unknown', 'Data type none is unknown'])
  })

  it('rejects a register point with no data type', () => {
    const report = validatePointTable([point({ address: 0, dataType: undefined })], {
      target: 'client'
    })
    expect(reasons(report)).toEqual(['A holding_registers point needs a dataType'])
  })

  it('takes a bit with no data type, or bool, and rejects one with a number type', () => {
    const report = validatePointTable(
      [
        { name: 'Run', address: 0, registerType: 'coils' },
        { name: 'Trip', address: 1, registerType: 'discrete_inputs', dataType: 'bool' },
        { name: 'Bad', address: 2, registerType: 'coils', dataType: 'int16' }
      ],
      { target: 'client' }
    )
    expect(reasons(report)).toEqual([
      undefined,
      undefined,
      'A coils point holds one bit; give it no dataType (or bool)'
    ])
  })

  it('rejects an address out of range, naming the notation', () => {
    const report = validatePointTable([point({ address: 0 })], {
      target: 'client',
      notation: 'one_based'
    })
    expect(reasons(report)).toEqual(['one_based address 0 is outside 1 to 65536'])
    expect(report.points[0]?.resolved).toBeUndefined()
  })

  it('rejects a point that runs past the last address, and takes one that ends on it', () => {
    const report = validatePointTable(
      [
        point({ address: 65533, dataType: 'double' }),
        point({ address: 65532, dataType: 'double' })
      ],
      { target: 'client' }
    )
    expect(reasons(report)).toEqual(['4 registers from 65533 run past 65535', undefined])
  })

  it('reads the width of a utf8 point off its length', () => {
    const report = validatePointTable(
      [
        point({ address: 0, dataType: 'utf8', length: 4 }),
        point({ address: 10, dataType: 'utf8' })
      ],
      { target: 'client' }
    )
    expect(report.points.map((entry) => entry.resolved?.width)).toEqual([4, 10])
  })

  it.each(['int16', 'uint16', 'bitmap', 'utf8'])('rejects a byte swap on %s', (dataType) => {
    const report = validatePointTable(
      [
        point({ address: 0, dataType, byteOrder: 'BADC' }),
        point({ address: 20, dataType, byteOrder: 'DCBA' })
      ],
      { target: 'client' }
    )
    expect(reasons(report)).toEqual([
      `Byte order BADC swaps bytes, which applies to 32 and 64 bit types, not ${dataType}`,
      `Byte order DCBA swaps bytes, which applies to 32 and 64 bit types, not ${dataType}`
    ])
  })

  it('takes a word order on a 16 bit type, which sets nothing for the table', () => {
    const report = validatePointTable(
      [
        point({ address: 0, dataType: 'int16', byteOrder: 'CDAB' }),
        point({ address: 1, dataType: 'int32', byteOrder: 'ABCD' })
      ],
      { target: 'client' }
    )
    expect(reasons(report)).toEqual([undefined, undefined])
    expect(report.byteOrder).toBe('ABCD')
  })

  it.each(['int32', 'uint32', 'float', 'unix', 'int64', 'uint64', 'double', 'datetime'])(
    'takes a byte swap on %s',
    (dataType) => {
      const report = validatePointTable([point({ address: 0, dataType, byteOrder: 'DCBA' })], {
        target: 'client'
      })
      expect(report.points[0]?.status).toBe('accepted')
      expect(report.byteOrder).toBe('DCBA')
    }
  )

  it('rejects a scaling on a type that takes none', () => {
    const report = validatePointTable(
      [
        point({ address: 0, dataType: 'unix', scalingFactor: 0.1 }),
        point({
          address: 2,
          dataType: 'utf8',
          length: 1,
          interpolate: { x1: 0, x2: 1, y1: 0, y2: 2 }
        })
      ],
      { target: 'client' }
    )
    expect(reasons(report)).toEqual([
      'A scaling factor or interpolation applies to int16, uint16, int32, uint32, int64, uint64, float, double, not unix',
      'A scaling factor or interpolation applies to int16, uint16, int32, uint32, int64, uint64, float, double, not utf8'
    ])
  })

  it('rejects a scaling factor of 0 on a client point', () => {
    const report = validatePointTable([point({ address: 0, scalingFactor: 0 })], {
      target: 'client'
    })
    expect(reasons(report)).toEqual(['A scaling factor of 0 maps every raw value to 0'])
  })
})

describe('validatePointTable, across the table', () => {
  it("rejects a byte order other than the table's", () => {
    const report = validatePointTable(
      [
        point({ address: 0, dataType: 'float', byteOrder: 'CDAB' }),
        point({ address: 2, dataType: 'int32', byteOrder: 'ABCD' }),
        point({ address: 4, dataType: 'uint32' })
      ],
      { target: 'client' }
    )
    expect(reasons(report)).toEqual([
      undefined,
      "Byte order ABCD differs from the table's CDAB; one configuration has one byte order",
      undefined
    ])
    expect(report.byteOrder).toBe('CDAB')
  })

  it('takes the byte order the table names over the first point', () => {
    const report = validatePointTable(
      [
        point({ address: 0, dataType: 'float', byteOrder: 'CDAB' }),
        point({ address: 2, dataType: 'float', byteOrder: 'DCBA' })
      ],
      { target: 'server', byteOrder: 'DCBA' }
    )
    expect(reasons(report)).toEqual([
      "Byte order CDAB differs from the table's DCBA; one configuration has one byte order",
      undefined
    ])
    expect(report.byteOrder).toBe('DCBA')
  })

  it('leaves the byte order unset when no point names one', () => {
    const report = validatePointTable([point({ address: 0, dataType: 'float' })], {
      target: 'client'
    })
    expect(report.byteOrder).toBeUndefined()
  })

  it("lets a rejected point's byte order set nothing", () => {
    const report = validatePointTable(
      [
        point({ address: 65535, dataType: 'float', byteOrder: 'CDAB' }),
        point({ address: 0, dataType: 'float', byteOrder: 'ABCD' })
      ],
      { target: 'client' }
    )
    expect(reasons(report)).toEqual(['2 registers from 65535 run past 65535', undefined])
    expect(report.byteOrder).toBe('ABCD')
  })

  it("rejects a client point under another unit id than the table's", () => {
    const report = validatePointTable(
      [point({ address: 0, unitId: 3 }), point({ address: 1, unitId: 4 }), point({ address: 2 })],
      { target: 'client' }
    )
    expect(reasons(report)).toEqual([
      undefined,
      "Unit id 4 differs from the table's 3; one client configuration reads one unit id",
      undefined
    ])
    expect(report.unitId).toBe(3)
    expect(report.points.map((entry) => entry.resolved?.unitId)).toEqual([3, 4, 3])
  })

  it("takes the table's unit id over the first point's", () => {
    const report = validatePointTable([point({ address: 0, unitId: 3 })], {
      target: 'client',
      unitId: 1
    })
    expect(reasons(report)).toEqual([
      "Unit id 3 differs from the table's 1; one client configuration reads one unit id"
    ])
  })

  it('takes several unit ids on a server table', () => {
    const report = validatePointTable(
      [point({ address: 0, unitId: 3 }), point({ address: 0, unitId: 4 }), point({ address: 0 })],
      { target: 'server', unitId: 1 }
    )
    expect(reasons(report)).toEqual([undefined, undefined, undefined])
    expect(report.points.map((entry) => entry.resolved?.unitId)).toEqual([3, 4, 1])
    expect(report.unitId).toBeUndefined()
  })

  it('rejects a point overlapping one accepted before it, on the same type and unit', () => {
    const report = validatePointTable(
      [
        point({ name: 'Energy', address: 10, dataType: 'uint64' }),
        point({ name: 'Inside', address: 13, dataType: 'uint16' }),
        point({ name: 'Across', address: 9, dataType: 'int32' }),
        point({ name: 'After', address: 14, dataType: 'uint16' }),
        point({ name: 'Other type', address: 10, registerType: 'input_registers' })
      ],
      { target: 'client' }
    )
    expect(reasons(report)).toEqual([
      undefined,
      'holding_registers 13 to 13 overlaps "Energy" at 10',
      'holding_registers 9 to 10 overlaps "Energy" at 10',
      undefined,
      undefined
    ])
  })

  // A client reads one unit id, so a point naming another is still read at
  // the address it shares.
  it('rejects an overlap on a client table whatever unit id each point names', () => {
    const report = validatePointTable(
      [
        point({ name: 'A', address: 100, dataType: 'uint32' }),
        point({ name: 'B', address: 101, dataType: 'uint16', unitId: 1 })
      ],
      { target: 'client' }
    )
    expect(reasons(report)).toEqual([undefined, 'holding_registers 101 to 101 overlaps "A" at 100'])
    expect(report.points[0]?.resolved?.unitId).toBe(report.unitId ?? 0)
  })

  it('takes the same address on two units of a server table', () => {
    const report = validatePointTable(
      [point({ address: 100, dataType: 'uint32' }), point({ address: 101, unitId: 1 })],
      { target: 'server' }
    )
    expect(reasons(report)).toEqual([undefined, undefined])
  })

  it('lets a rejected point block nothing', () => {
    const report = validatePointTable(
      [point({ address: 10, dataType: 'float32' }), point({ address: 10 })],
      { target: 'client' }
    )
    expect(reasons(report)).toEqual(['Data type float32 is unknown', undefined])
    expect([report.accepted, report.rejected]).toEqual([1, 1])
  })
})

describe('validatePointTable, server values', () => {
  const serverPoint = (
    fields: Partial<ServerPoint> & Pick<ServerPoint, 'address'>
  ): ServerPoint => ({
    ...point(fields),
    ...fields
  })

  it('stores the raw value of a fixed engineering value', () => {
    const report = validatePointTable(
      [serverPoint({ address: 0, dataType: 'float', scalingFactor: 0.1, value: 230.5 })],
      { target: 'server' }
    )
    expect(report.points[0]?.resolved).toMatchObject({ raw: 2305 })
  })

  it('stores raw 0 for a register with neither a value nor a generator, and false for a bit', () => {
    const report = validatePointTable(
      [serverPoint({ address: 0 }), { name: 'Run', address: 0, registerType: 'coils' }],
      { target: 'server' }
    )
    expect(report.points.map((entry) => entry.resolved?.raw)).toEqual([0, false])
  })

  it('stores a generator range in raw values, lowest first', () => {
    const report = validatePointTable(
      [
        serverPoint({
          address: 0,
          dataType: 'int16',
          scalingFactor: -0.1,
          generator: { min: 10, max: 20, intervalSeconds: 5 }
        })
      ],
      { target: 'server' }
    )
    expect(report.points[0]?.resolved?.generator).toEqual({
      min: -200,
      max: -100,
      intervalMs: 5000
    })
  })

  it('gives a timestamp generator the range the store pins, and rejects one with a range', () => {
    const report = validatePointTable(
      [
        serverPoint({ address: 0, dataType: 'unix', generator: {} }),
        serverPoint({ address: 2, dataType: 'datetime', generator: { min: 0, max: 1 } })
      ],
      { target: 'server' }
    )
    expect(report.points[0]?.resolved?.generator).toEqual({ min: 0, max: 0, intervalMs: 1000 })
    expect(reasons(report)).toEqual([
      undefined,
      'A datetime generator reads the clock and takes no min or max'
    ])
  })

  it.each([
    [
      { dataType: 'uint16', value: 70000 },
      'Raw value 70000: A uint16 value has to be between 0 and 65535'
    ],
    [
      { dataType: 'uint16', value: 1, generator: { min: 0, max: 1 } },
      'A point takes a fixed value or a generator, not both'
    ],
    [{ dataType: 'uint16', generator: { min: 0 } }, 'A generator needs a min and a max'],
    [
      { dataType: 'uint16', generator: { min: -1, max: 1 } },
      'Generator min: Raw value -1: A uint16 value has to be between 0 and 65535'
    ],
    [
      { dataType: 'uint16', generator: { min: 0, max: 70000 } },
      'Generator max: Raw value 70000: A uint16 value has to be between 0 and 65535'
    ],
    [{ dataType: 'uint16', value: true }, 'A uint16 value is a number'],
    [{ dataType: 'utf8', length: 2, value: 'abcde' }, '"abcde" is 5 bytes, and 2 registers hold 4'],
    [{ dataType: 'utf8', value: 3 }, 'A utf8 value is a string'],
    [{ dataType: 'utf8', generator: { min: 0, max: 1 } }, 'A utf8 point has no generator']
  ] as const)('rejects %j', (fields, reason) => {
    const report = validatePointTable([serverPoint({ address: 0, ...fields })], {
      target: 'server'
    })
    expect(reasons(report)).toEqual([reason])
  })

  it.each([
    [{ value: 1 }, 'A coils value is true or false'],
    [{ generator: { min: 0, max: 1 } }, 'A coils point has no generator']
  ] as const)('rejects a coil with %j', (fields, reason) => {
    const report = validatePointTable(
      [{ name: 'Run', address: 0, registerType: 'coils', ...fields }],
      { target: 'server' }
    )
    expect(reasons(report)).toEqual([reason])
  })

  it('stores a utf8 string as its raw value', () => {
    const report = validatePointTable(
      [serverPoint({ address: 0, dataType: 'utf8', length: 3, value: 'Modbux' })],
      { target: 'server' }
    )
    expect(report.points[0]?.resolved).toMatchObject({ raw: 'Modbux', width: 3 })
  })

  it('ignores a value on a client table, which the client schema does not carry', () => {
    const parsed = PointSchema.parse({ name: 'V', address: 0, registerType: 'coils', value: 3 })
    expect(parsed).not.toHaveProperty('value')
  })
})

describe('what an accepted table becomes', () => {
  const report = validatePointTable(
    [
      {
        name: 'Voltage',
        address: 40011,
        dataType: 'float',
        scalingFactor: 0.1,
        unit: 'V',
        value: 230.5,
        byteOrder: 'CDAB'
      },
      { name: 'Energy', address: 40001, dataType: 'int32', value: -123456, generator: undefined },
      {
        name: 'Level',
        address: 40021,
        dataType: 'uint16',
        interpolate: { x1: 4, x2: 20, y1: 0, y2: 100 },
        generator: { min: 0, max: 100 }
      },
      { name: 'Serial', address: 30001, dataType: 'utf8', length: 4, value: 'AB12' },
      { name: 'Run', address: '00005', value: true },
      { name: 'Bad', address: 40001, dataType: 'int16' }
    ] satisfies ServerPoint[],
    { target: 'server', notation: 'modicon', unitId: 2 }
  )
  const points = acceptedPoints(report)

  it('keeps the accepted points in table order', () => {
    expect(points.map((entry) => entry.comment)).toEqual([
      'Voltage [V]',
      'Energy',
      'Level',
      'Serial',
      'Run'
    ])
  })

  it('maps each accepted point under its register type and PDU address', () => {
    const mapping = clientMappingOf(points)
    expect(mapping.holding_registers).toEqual({
      0: { comment: 'Energy', dataType: 'int32' },
      10: { comment: 'Voltage [V]', dataType: 'float', scalingFactor: 0.1 },
      20: {
        comment: 'Level',
        dataType: 'uint16',
        interpolate: { x1: '4', x2: '20', y1: '0', y2: '100' }
      }
    })
    expect(mapping.input_registers).toEqual({ 0: { comment: 'Serial', dataType: 'utf8' } })
    expect(mapping.coils).toEqual({ 4: { comment: 'Run' } })
    expect(mapping.discrete_inputs).toEqual({})
  })

  it("reads the first point's type from its lowest address to its furthest end", () => {
    expect(readWindowOf(points)).toEqual({
      window: { type: 'holding_registers', address: 0, length: 21 },
      otherTypes: ['input_registers', 'coils']
    })
    expect(readWindowOf([])).toBeUndefined()
  })

  it('builds the params the server stores, and none for a bit', () => {
    expect(points.map(serverRegisterParams)).toEqual([
      {
        address: 10,
        registerType: 'holding_registers',
        dataType: 'float',
        comment: 'Voltage [V]',
        value: 2305
      },
      {
        address: 0,
        registerType: 'holding_registers',
        dataType: 'int32',
        comment: 'Energy',
        value: -123456
      },
      {
        address: 20,
        registerType: 'holding_registers',
        dataType: 'uint16',
        comment: 'Level',
        min: 4,
        max: 20,
        interval: 1000
      },
      {
        address: 0,
        registerType: 'input_registers',
        dataType: 'utf8',
        comment: 'Serial',
        value: 0,
        stringValue: 'AB12',
        length: 4
      },
      undefined
    ])
  })

  it('puts every point under its unit', () => {
    const units = serverUnitsOf(points)
    expect(Object.keys(units)).toEqual(['2'])
    expect(units['2']?.coils).toEqual({ 4: { value: true, comment: 'Run' } })
    expect(Object.keys(units['2']?.holding_registers ?? {})).toEqual(['0', '10', '20'])
    // A fixed register holds its raw value at once, a generated one 0.
    expect(units['2']?.holding_registers[10]).toEqual({
      value: 2305,
      params: expect.objectContaining({ value: 2305 })
    })
    expect(units['2']?.holding_registers[20]?.value).toBe(0)
    expect(units['2']?.input_registers[0]?.value).toBe(0)
    expect(units['2']?.discrete_inputs).toEqual({})
  })
})

it('holds a 64 bit integer as the decimal string the store keeps', () => {
  const report = validatePointTable(
    [
      {
        name: 'Energy',
        address: 0,
        registerType: 'holding_registers',
        dataType: 'int64',
        value: -5
      }
    ],
    { target: 'server' }
  )
  expect(serverUnitsOf(acceptedPoints(report))['0']?.holding_registers[0]?.value).toBe('-5')
})

// The fold keeps a datetime as the four ABCD words packed into 64 bits, so
// the seed is that composite and not the milliseconds the table gave.
it('holds a fixed datetime as the packed composite the store keeps', () => {
  const ms = Date.UTC(2024, 0, 1, 12, 30, 0)
  const report = validatePointTable(
    [
      {
        name: 'Clock',
        address: 0,
        registerType: 'holding_registers',
        dataType: 'datetime',
        value: ms
      }
    ],
    { target: 'server' }
  )
  expect(serverUnitsOf(acceptedPoints(report))['0']?.holding_registers[0]?.value).toBe(
    '6756503450943488'
  )
})

// The scalable types the forward conversion reads, so a type added there and
// not here is a test that names it.
it('round trips every scalable type through scaleValue', () => {
  const types: DataType[] = [
    'int16',
    'uint16',
    'int32',
    'uint32',
    'int64',
    'uint64',
    'float',
    'double'
  ]
  for (const dataType of types) {
    const conversion = engineeringToRaw(12.5, dataType, { scalingFactor: 0.5 })
    expect(conversion).toEqual({ ok: true, raw: 25 })
    expect(scaleValue('25', dataType, { scalingFactor: 0.5 })).toBe(12.5)
  }
})
