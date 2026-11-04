import { describe, it, expect } from 'vitest'
import {
  getBit,
  reorderBytes,
  createRegisters,
  createStringRegisters,
  encodeIEC870DateTime,
  registerWidth,
  getMinMaxValues
} from '../encoding'
import { convertRegisterData, parseIEC870DateTime } from '../conversion'
import { byteOrderFlags, type ByteOrderFlags } from '../types/byteOrder'

// ---------------------------------------------------------------------------
// getBit
// ---------------------------------------------------------------------------
describe('getBit', () => {
  it('returns correct bit from a word', () => {
    // 0b1010 = 10
    expect(getBit(0b1010, 0)).toBe(false)
    expect(getBit(0b1010, 1)).toBe(true)
    expect(getBit(0b1010, 2)).toBe(false)
    expect(getBit(0b1010, 3)).toBe(true)
  })

  it('returns false for bits beyond the value', () => {
    expect(getBit(1, 15)).toBe(false)
  })

  it('handles 0xFFFF (all bits set)', () => {
    for (let i = 0; i < 16; i++) {
      expect(getBit(0xffff, i)).toBe(true)
    }
  })

  it('handles 0 (no bits set)', () => {
    for (let i = 0; i < 16; i++) {
      expect(getBit(0, i)).toBe(false)
    }
  })

  it('reads a bit past the width of a signed 32 bit AND', () => {
    expect(getBit(2 ** 31, 31)).toBe(true)
    expect(getBit(2 ** 32, 32)).toBe(true)
    expect(getBit(2 ** 32, 31)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// reorderBytes
// ---------------------------------------------------------------------------
const ABCD = byteOrderFlags('ABCD')
const CDAB = byteOrderFlags('CDAB')
const BADC = byteOrderFlags('BADC')
const DCBA = byteOrderFlags('DCBA')

describe('reorderBytes', () => {
  const value32 = Uint8Array.from([0x12, 0x34, 0x56, 0x78])
  const value64 = Uint8Array.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07])

  it.each([
    ['ABCD', ABCD, [0x12, 0x34, 0x56, 0x78]],
    ['CDAB', CDAB, [0x56, 0x78, 0x12, 0x34]],
    ['BADC', BADC, [0x34, 0x12, 0x78, 0x56]],
    ['DCBA', DCBA, [0x78, 0x56, 0x34, 0x12]]
  ])('lays 0x12345678 out as %s', (_name, order, expected) => {
    expect([...reorderBytes(value32, order)]).toEqual(expected)
  })

  it.each([
    ['ABCD', ABCD, [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]],
    ['CDAB', CDAB, [0x06, 0x07, 0x04, 0x05, 0x02, 0x03, 0x00, 0x01]],
    ['BADC', BADC, [0x01, 0x00, 0x03, 0x02, 0x05, 0x04, 0x07, 0x06]],
    ['DCBA', DCBA, [0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01, 0x00]]
  ])('lays a 64 bit value out as %s', (_name, order, expected) => {
    expect([...reorderBytes(value64, order)]).toEqual(expected)
  })

  it.each([
    ['ABCD', ABCD],
    ['CDAB', CDAB],
    ['BADC', BADC],
    ['DCBA', DCBA]
  ])('undoes itself in %s', (_name, order) => {
    expect([...reorderBytes(reorderBytes(value64, order), order)]).toEqual([...value64])
  })

  it('leaves a one register value as it is in every order', () => {
    for (const order of [ABCD, CDAB, BADC, DCBA]) {
      expect([...reorderBytes(Uint8Array.from([0x12, 0x34]), order)]).toEqual([0x12, 0x34])
    }
  })

  it('answers a copy, so the caller keeps its own bytes', () => {
    const bytes = Uint8Array.from([0x12, 0x34, 0x56, 0x78])
    const reordered = reorderBytes(bytes, ABCD)
    reordered[0] = 0
    expect(bytes[0]).toBe(0x12)
  })
})

// ---------------------------------------------------------------------------
// createRegisters
// ---------------------------------------------------------------------------
describe('registerWidth', () => {
  it('is 1 for the 16-bit types', () => {
    expect(registerWidth('int16')).toBe(1)
    expect(registerWidth('uint16')).toBe(1)
    expect(registerWidth('bitmap')).toBe(1)
  })

  it('is 2 for the 32-bit types', () => {
    expect(registerWidth('int32')).toBe(2)
    expect(registerWidth('uint32')).toBe(2)
    expect(registerWidth('float')).toBe(2)
    expect(registerWidth('unix')).toBe(2)
  })

  it('is 4 for the 64-bit types', () => {
    expect(registerWidth('int64')).toBe(4)
    expect(registerWidth('uint64')).toBe(4)
    expect(registerWidth('double')).toBe(4)
    expect(registerWidth('datetime')).toBe(4)
  })

  it('is the length the user gave for a string', () => {
    expect(registerWidth('utf8', 2)).toBe(2)
    expect(registerWidth('utf8', 124)).toBe(124)
  })

  it('is 10 for a string with no length, which is what the dialog offers', () => {
    expect(registerWidth('utf8')).toBe(10)
  })

  it('ignores a length on a type that does not have one', () => {
    expect(registerWidth('int16', 7)).toBe(1)
    expect(registerWidth('double', 7)).toBe(4)
  })

  it('is 1 for none, which occupies its address without holding a value', () => {
    expect(registerWidth('none')).toBe(1)
  })
})

describe('createRegisters', () => {
  describe('int16', () => {
    it('converts positive value', () => {
      const regs = createRegisters('int16', 1234, ABCD)
      expect(regs).toHaveLength(1)
      expect(regs[0]).toBe(1234)
    })

    it('converts negative value', () => {
      const regs = createRegisters('int16', -1, ABCD)
      expect(regs).toHaveLength(1)
      // -1 in int16 big-endian = 0xFFFF = 65535
      expect(regs[0]).toBe(65535)
    })

    it('converts zero', () => {
      expect(createRegisters('int16', 0, ABCD)).toEqual([0])
    })

    it('converts max value (32767)', () => {
      const regs = createRegisters('int16', 32767, ABCD)
      expect(regs[0]).toBe(32767)
    })

    it('converts min value (-32768)', () => {
      const regs = createRegisters('int16', -32768, ABCD)
      expect(regs[0]).toBe(32768) // 0x8000
    })

    it('ignores littleEndian flag (only 1 register)', () => {
      expect(createRegisters('int16', 100, CDAB)).toEqual(createRegisters('int16', 100, ABCD))
    })
  })

  describe('uint16', () => {
    it('converts positive value', () => {
      expect(createRegisters('uint16', 65535, ABCD)).toEqual([65535])
    })

    it('converts zero', () => {
      expect(createRegisters('uint16', 0, ABCD)).toEqual([0])
    })
  })

  describe('bitmap', () => {
    it('produces a single register identical to uint16', () => {
      expect(createRegisters('bitmap', 42, ABCD)).toEqual([42])
    })

    it('converts zero', () => {
      expect(createRegisters('bitmap', 0, ABCD)).toEqual([0])
    })

    it('converts max value', () => {
      expect(createRegisters('bitmap', 65535, ABCD)).toEqual([65535])
    })
  })

  describe('int32 (big endian)', () => {
    it('converts positive value to 2 registers', () => {
      const regs = createRegisters('int32', 70000, ABCD)
      expect(regs).toHaveLength(2)
      // 70000 = 0x00011170 → registers: [0x0001, 0x1170] = [1, 4464]
      expect(regs[0]).toBe(1)
      expect(regs[1]).toBe(4464)
    })

    it('converts negative value', () => {
      const regs = createRegisters('int32', -1, ABCD)
      // -1 = 0xFFFFFFFF → [0xFFFF, 0xFFFF] = [65535, 65535]
      expect(regs).toEqual([65535, 65535])
    })
  })

  describe('int32 (little endian)', () => {
    it('swaps words compared to big endian', () => {
      const be = createRegisters('int32', 70000, ABCD)
      const le = createRegisters('int32', 70000, CDAB)
      expect(le).toHaveLength(2)
      // Little endian swaps the two 16-bit words
      expect(le[0]).toBe(be[1])
      expect(le[1]).toBe(be[0])
    })
  })

  describe('uint32', () => {
    it('converts max uint32', () => {
      const regs = createRegisters('uint32', 4294967295, ABCD)
      expect(regs).toEqual([65535, 65535])
    })

    it('converts zero', () => {
      expect(createRegisters('uint32', 0, ABCD)).toEqual([0, 0])
    })
  })

  describe('float', () => {
    it('converts 1.0 to correct registers', () => {
      const regs = createRegisters('float', 1.0, ABCD)
      expect(regs).toHaveLength(2)
      // IEEE 754: 1.0f = 0x3F800000 → [0x3F80, 0x0000] = [16256, 0]
      expect(regs[0]).toBe(16256)
      expect(regs[1]).toBe(0)
    })

    it('converts -1.5 correctly', () => {
      const regs = createRegisters('float', -1.5, ABCD)
      expect(regs).toHaveLength(2)
      // -1.5f = 0xBFC00000 → [0xBFC0, 0x0000]
      expect(regs[0]).toBe(0xbfc0)
      expect(regs[1]).toBe(0)
    })

    it('handles little endian word swap', () => {
      const be = createRegisters('float', 3.14, ABCD)
      const le = createRegisters('float', 3.14, CDAB)
      expect(le[0]).toBe(be[1])
      expect(le[1]).toBe(be[0])
    })
  })

  describe('int64', () => {
    it('converts to 4 registers', () => {
      const regs = createRegisters('int64', 1, ABCD)
      expect(regs).toHaveLength(4)
      expect(regs).toEqual([0, 0, 0, 1])
    })

    it('converts negative value', () => {
      const regs = createRegisters('int64', -1, ABCD)
      expect(regs).toEqual([65535, 65535, 65535, 65535])
    })

    it('handles little endian word reversal', () => {
      const be = createRegisters('int64', 1, ABCD)
      const le = createRegisters('int64', 1, CDAB)
      // LE reverses all 4 words
      expect(le[0]).toBe(be[3])
      expect(le[1]).toBe(be[2])
      expect(le[2]).toBe(be[1])
      expect(le[3]).toBe(be[0])
    })
  })

  describe('uint64', () => {
    it('converts to 4 registers', () => {
      expect(createRegisters('uint64', 0, ABCD)).toEqual([0, 0, 0, 0])
      expect(createRegisters('uint64', 1, ABCD)).toEqual([0, 0, 0, 1])
    })

    it('applies little endian word swap', () => {
      const be = createRegisters('uint64', 1, ABCD)
      const le = createRegisters('uint64', 1, CDAB)
      expect(le).toEqual([be[3], be[2], be[1], be[0]])
    })
  })

  describe('double', () => {
    it('converts 1.0 to 4 registers', () => {
      const regs = createRegisters('double', 1.0, ABCD)
      expect(regs).toHaveLength(4)
      // IEEE 754 double: 1.0 = 0x3FF0000000000000
      // → [0x3FF0, 0x0000, 0x0000, 0x0000]
      expect(regs[0]).toBe(0x3ff0)
      expect(regs[1]).toBe(0)
      expect(regs[2]).toBe(0)
      expect(regs[3]).toBe(0)
    })

    it('handles little endian word reversal', () => {
      const be = createRegisters('double', 1.0, ABCD)
      const le = createRegisters('double', 1.0, CDAB)
      expect(le[0]).toBe(be[3])
      expect(le[1]).toBe(be[2])
      expect(le[2]).toBe(be[1])
      expect(le[3]).toBe(be[0])
    })
  })

  /** The registers as the bytes they stand for, big endian. */
  const toBuffer = (registers: number[]): Buffer => {
    const buffer = Buffer.alloc(registers.length * 2)
    registers.forEach((register, i) => buffer.writeUInt16BE(register, i * 2))
    return buffer
  }

  describe('round-trip consistency', () => {
    it('int32: value → registers → buffer → value', () => {
      const value = 123456
      const regs = createRegisters('int32', value, ABCD)
      expect(toBuffer(regs).readInt32BE(0)).toBe(value)
    })

    it('float: value → registers → buffer → value', () => {
      const value = 3.14
      const regs = createRegisters('float', value, ABCD)
      expect(toBuffer(regs).readFloatBE(0)).toBeCloseTo(value, 2)
    })

    it('double: value → registers → buffer → value', () => {
      const value = 3.141592653589793
      const regs = createRegisters('double', value, ABCD)
      expect(toBuffer(regs).readDoubleBE(0)).toBeCloseTo(value, 10)
    })

    it('uint32 little endian: value → registers → swapped buffer → value', () => {
      const value = 70000
      const regs = createRegisters('uint32', value, CDAB)
      // The two words go back the other way round to be read
      const swapped = Buffer.from(reorderBytes(toBuffer(regs), CDAB))
      expect(swapped.readUInt32BE(0)).toBe(value)
    })
  })
})

// ---------------------------------------------------------------------------
// getMinMaxValues
// ---------------------------------------------------------------------------
describe('getMinMaxValues', () => {
  it('returns correct range for int16', () => {
    expect(getMinMaxValues('int16')).toEqual({ min: -32768, max: 32767 })
  })

  it('returns correct range for uint16', () => {
    expect(getMinMaxValues('uint16')).toEqual({ min: 0, max: 65535 })
  })

  it('returns correct range for bitmap (same as uint16)', () => {
    expect(getMinMaxValues('bitmap')).toEqual({ min: 0, max: 65535 })
  })

  it('returns correct range for int32', () => {
    expect(getMinMaxValues('int32')).toEqual({ min: -2147483648, max: 2147483647 })
  })

  it('returns correct range for uint32', () => {
    expect(getMinMaxValues('uint32')).toEqual({ min: 0, max: 4294967295 })
  })

  it('returns safe integer range for int64', () => {
    expect(getMinMaxValues('int64')).toEqual({
      min: Number.MIN_SAFE_INTEGER,
      max: Number.MAX_SAFE_INTEGER
    })
  })

  it('returns 0 to MAX_SAFE_INTEGER for uint64', () => {
    expect(getMinMaxValues('uint64')).toEqual({
      min: 0,
      max: Number.MAX_SAFE_INTEGER
    })
  })

  it('returns infinity range for float', () => {
    const { min, max } = getMinMaxValues('float')
    expect(min).toBe(Number.NEGATIVE_INFINITY)
    expect(max).toBe(Number.POSITIVE_INFINITY)
  })

  it('returns infinity range for double', () => {
    const { min, max } = getMinMaxValues('double')
    expect(min).toBe(Number.NEGATIVE_INFINITY)
    expect(max).toBe(Number.POSITIVE_INFINITY)
  })

  it('returns { min: 0, max: 0 } for the two types that hold no number', () => {
    expect(getMinMaxValues('none')).toEqual({ min: 0, max: 0 })
    expect(getMinMaxValues('utf8')).toEqual({ min: 0, max: 0 })
  })

  it('states the unix range in the seconds createRegisters writes', () => {
    const { min, max } = getMinMaxValues('unix')
    expect(min).toBe(0)
    expect(max).toBe(4294967295)
    expect(createRegisters('unix', max, ABCD)).toEqual([0xffff, 0xffff])
  })

  it('states the datetime range in the milliseconds createRegisters writes', () => {
    const { min, max } = getMinMaxValues('datetime')
    expect(parseIEC870DateTime(encodeIEC870DateTime(min))).toBe('2000/01/01 00:00:00')
    expect(parseIEC870DateTime(encodeIEC870DateTime(max))).toBe('2127/12/31 23:59:59')
  })
})

// ---------------------------------------------------------------------------
// encodeIEC870DateTime
// ---------------------------------------------------------------------------
describe('encodeIEC870DateTime', () => {
  it('round trips a timestamp inside the range', () => {
    const timestampMs = Date.UTC(2024, 5, 1, 12, 34, 56, 789)
    expect(parseIEC870DateTime(encodeIEC870DateTime(timestampMs))).toBe('2024/06/01 12:34:56')
  })

  it('clamps a timestamp before 2000 to the first second of 2000', () => {
    expect(parseIEC870DateTime(encodeIEC870DateTime(0))).toBe('2000/01/01 00:00:00')
  })

  it('clamps a timestamp past 2127 to the last second of 2127', () => {
    const year2200 = Date.UTC(2200, 0, 1)
    expect(parseIEC870DateTime(encodeIEC870DateTime(year2200))).toBe('2127/12/31 23:59:59')
  })

  it('keeps the four registers createRegisters splits it into', () => {
    const timestampMs = Date.UTC(2024, 5, 1, 12, 34, 56, 789)
    expect(createRegisters('datetime', timestampMs, ABCD)).toEqual([0x0018, 0x0601, 0x0c22, 0xddd5])
  })
})

// ---------------------------------------------------------------------------
describe('createStringRegisters', () => {
  it('packs two characters into one register', () => {
    expect(createStringRegisters('AB', 1)).toEqual([0x4142])
  })

  it('pads the registers it was given with zeros', () => {
    expect(createStringRegisters('A', 2)).toEqual([0x4100, 0x0000])
  })

  it('answers zeros for no text at all', () => {
    expect(createStringRegisters('', 2)).toEqual([0x0000, 0x0000])
  })

  it('cuts text longer than the registers it was given', () => {
    expect(createStringRegisters('ABCD', 1)).toEqual([0x4142])
  })

  // A register is two bytes and a character need not be: the two bytes of the
  // `e9` are `c3` and `a9`, and the register boundary falls between them.
  it('carries a character across a register boundary', () => {
    expect(createStringRegisters('a\u00e9', 2)).toEqual([0x61c3, 0xa900])
  })

  // `Buffer.write` writes whole characters only. A character that does not fit
  // leaves its bytes at zero rather than half of them in the register.
  it('drops a character that does not fit rather than half of it', () => {
    expect(createStringRegisters('a\u00e9', 1)).toEqual([0x6100])
  })
})

// ---------------------------------------------------------------------------
// The four byte orders, through the encoder and back through the decoder
// ---------------------------------------------------------------------------
describe('createRegisters then convertRegisterData', () => {
  const ORDERS = [
    ['ABCD', ABCD],
    ['CDAB', CDAB],
    ['BADC', BADC],
    ['DCBA', DCBA]
  ] as const

  // Every byte of each value differs from the others, so a decoder in another
  // order reads a different value rather than the same one by symmetry.
  const datetimeMs = Date.UTC(2024, 5, 1, 12, 34, 56, 0)
  const VALUES = [
    ['int32', -70000, -70000],
    ['uint32', 4023233417, 4023233417],
    ['float', 3.14, 3.14],
    ['unix', 1700000000, '2023/11/14 22:13:20'],
    ['int64', -1234567890123, BigInt(-1234567890123)],
    ['uint64', 0x0012_3456_789a_bcde, BigInt(0x0012_3456_789a_bcde)],
    ['double', 2.718281828, 2.718281828],
    ['datetime', datetimeMs, '2024/06/01 12:34:56']
  ] as const

  const decode = (
    registers: number[],
    order: ByteOrderFlags,
    dataType: (typeof VALUES)[number][0]
  ): unknown => {
    const buffer = Buffer.alloc(registers.length * 2)
    for (const [i, register] of registers.entries()) buffer.writeUInt16BE(register, i * 2)
    return convertRegisterData({ data: registers, buffer }, 0, order, false)[0]?.words?.[dataType]
  }

  for (const [dataType, value, decoded] of VALUES) {
    for (const [name, order] of ORDERS) {
      it(`${dataType} comes back in ${name}`, () => {
        expect(decode(createRegisters(dataType, value, order), order, dataType)).toEqual(decoded)
      })

      it(`${dataType} written in ${name} reads differently in the other three`, () => {
        const registers = createRegisters(dataType, value, order)
        for (const [otherName, other] of ORDERS) {
          if (otherName === name) continue
          expect(decode(registers, other, dataType)).not.toEqual(decoded)
        }
      })
    }
  }

  it('lays the same float out in four different ways', () => {
    expect(createRegisters('float', 3.14, ABCD)).toEqual([0x4048, 0xf5c3])
    expect(createRegisters('float', 3.14, CDAB)).toEqual([0xf5c3, 0x4048])
    expect(createRegisters('float', 3.14, BADC)).toEqual([0x4840, 0xc3f5])
    expect(createRegisters('float', 3.14, DCBA)).toEqual([0xc3f5, 0x4840])
  })

  it('leaves the 16 bit types alone in every order', () => {
    for (const [, order] of ORDERS) {
      expect(createRegisters('int16', -2, order)).toEqual([0xfffe])
      expect(createRegisters('uint16', 0x1234, order)).toEqual([0x1234])
      expect(createRegisters('bitmap', 0x1234, order)).toEqual([0x1234])
    }
  })
})
