import { describe, it, expect } from 'vitest'
import type { AddressGroup, RegisterData, RegisterMapObject } from '../types'
import { engineeringValue, linearInterpolate, scaleValue } from '../engineeringValue'

/** A row carrying the utf8 the read buffer holds from this address onward. */
const rowAt = (address: number, utf8: string): RegisterData => ({
  id: address,
  buffer: Buffer.alloc(2),
  hex: '',
  words: {
    int16: 0,
    uint16: 0,
    int32: 0,
    uint32: 0,
    float: 0,
    unix: '',
    int64: BigInt(0),
    uint64: BigInt(0),
    double: 0,
    datetime: '',
    utf8
  },
  bit: false,
  isScanned: false
})

/**
 * A row carrying one number under every type that reads it as one, and one
 * string under the two time types.
 */
const numberRowAt = (address: number, value: number, time = ''): RegisterData => ({
  ...rowAt(address, ''),
  words: {
    int16: value,
    uint16: value,
    int32: value,
    uint32: value,
    float: value,
    unix: time,
    int64: BigInt(Number.isInteger(value) ? value : 0),
    uint64: BigInt(Number.isInteger(value) ? value : 0),
    double: value,
    datetime: time,
    utf8: ''
  }
})

const shown = (
  registerMap: RegisterMapObject,
  row: RegisterData,
  groups: AddressGroup[] = [],
  showRaw = false
): number | string | undefined => engineeringValue(row, registerMap, groups, showRaw)

describe('how much of a string engineeringValue answers', () => {
  // The group is [address, address + length), so four registers hold eight
  // characters and the ninth belongs to whatever was read after them.
  it('stops at the last register of the group', () => {
    expect(shown({ 0: { dataType: 'utf8' } }, rowAt(0, 'ABCDEFGHIJKL'), [[0, 4]])).toBe('ABCDEFGH')
  })

  it('stops at the next register the mapping gives a type', () => {
    expect(
      shown({ 0: { dataType: 'utf8' }, 3: { dataType: 'uint16' } }, rowAt(0, 'ABCDEFGHIJKL'), [
        [0, 8]
      ])
    ).toBe('ABCDEF')
  })

  it('runs over a register the mapping marks none', () => {
    expect(
      shown(
        { 0: { dataType: 'utf8' }, 1: { dataType: 'none' }, 2: { dataType: 'uint16' } },
        rowAt(0, 'ABCDEFGH'),
        [[0, 4]]
      )
    ).toBe('ABCD')
  })

  it('counts from the address the string starts at, not from the group', () => {
    expect(shown({ 2: { dataType: 'utf8' } }, rowAt(2, 'CDEFGHIJKL'), [[0, 6]])).toBe('CDEFGHIJ')
  })

  it('picks the group the address is in, among several', () => {
    expect(
      shown({ 10: { dataType: 'utf8' } }, rowAt(10, 'ABCDEFGH'), [
        [0, 4],
        [10, 2]
      ])
    ).toBe('ABCD')
  })

  it('answers nothing for an address outside every group', () => {
    expect(shown({ 9: { dataType: 'utf8' } }, rowAt(9, 'ABCD'), [[0, 4]])).toBe(undefined)
  })
})

// `String(undefined)` is the word "undefined" and the guard below it asked
// whether the string was empty, so a row carrying no words drew that word. The
// UTF-8 column cut it to the group, which is `"undefine"` over four registers.
describe('a row that carries no words', () => {
  // What `convertBitData` writes for a coil or a discrete input.
  const wordless = (address: number): RegisterData => ({
    ...rowAt(address, ''),
    words: undefined
  })

  it.each(['datetime', 'unix', 'uint16'] as const)('answers nothing for %s', (dataType) => {
    expect(shown({ 0: { dataType } }, wordless(0))).toBe(undefined)
  })

  it('answers nothing for utf8', () => {
    expect(shown({ 0: { dataType: 'utf8' } }, wordless(0), [[0, 4]])).toBe(undefined)
  })
})

describe('the rows engineeringValue answers nothing for', () => {
  it('answers nothing for a row that failed, whatever it carries', () => {
    const failed = { ...numberRowAt(0, 5), error: 'Timed out' }
    expect(shown({ 0: { dataType: 'uint16' } }, failed)).toBe(undefined)
  })

  it('answers nothing for an address the mapping gives no type', () => {
    expect(shown({}, numberRowAt(0, 5))).toBe(undefined)
    expect(shown({ 0: { comment: 'x' } }, numberRowAt(0, 5))).toBe(undefined)
  })

  it('answers nothing for an address the mapping marks none', () => {
    expect(shown({ 0: { dataType: 'none' } }, numberRowAt(0, 5))).toBe(undefined)
  })

  it('answers nothing for a word that is not a number', () => {
    expect(shown({ 0: { dataType: 'float' } }, numberRowAt(0, NaN))).toBe(undefined)
  })
})

describe('the types that answer a string', () => {
  it.each(['datetime', 'unix'] as const)('answers the %s word unscaled', (dataType) => {
    const row = numberRowAt(0, 0, '2026-01-02 03:04:05')
    expect(shown({ 0: { dataType, scalingFactor: 10 } }, row)).toBe('2026-01-02 03:04:05')
  })
})

describe('the number engineeringValue answers', () => {
  // The rounding takes its precision from the factor, so a factor with one
  // decimal that rounded to none would show 12 for a register holding 123.
  it('keeps the decimals the scaling factor introduces', () => {
    expect(shown({ 0: { dataType: 'uint16', scalingFactor: 0.1 } }, numberRowAt(0, 123))).toBe(12.3)
  })

  // `3 * 0.1` is `0.30000000000000004`.
  it('rounds away what the multiplication adds past the factor decimals', () => {
    expect(shown({ 0: { dataType: 'uint16', scalingFactor: 0.1 } }, numberRowAt(0, 3))).toBe(0.3)
  })

  // A float carries decimals of its own, and the factor's count alone would
  // round them away.
  it('keeps the decimals of a float beside those of the factor', () => {
    expect(shown({ 0: { dataType: 'float', scalingFactor: 0.1 } }, numberRowAt(0, 1.25))).toBe(
      0.125
    )
  })

  it('keeps the decimals of a double beside those of the factor', () => {
    expect(shown({ 0: { dataType: 'double', scalingFactor: 0.1 } }, numberRowAt(0, 1.25))).toBe(
      0.125
    )
  })

  // An integer type takes the factor's decimals alone, so a word that somehow
  // carried decimals is still rounded to them.
  it('rounds an integer type to the decimals of the factor alone', () => {
    expect(shown({ 0: { dataType: 'int32', scalingFactor: 0.1 } }, numberRowAt(0, 1.25))).toBe(0.1)
  })

  it('takes a factor of 1 when the mapping has none', () => {
    expect(shown({ 0: { dataType: 'int16' } }, numberRowAt(0, -42))).toBe(-42)
  })

  it('scales a 64 bit word', () => {
    expect(shown({ 0: { dataType: 'uint64', scalingFactor: 0.01 } }, numberRowAt(0, 12345))).toBe(
      123.45
    )
  })

  it('answers the word itself when raw is asked for', () => {
    expect(
      shown(
        {
          0: {
            dataType: 'uint16',
            scalingFactor: 0.1,
            interpolate: { x1: '0', x2: '1', y1: '0', y2: '100' }
          }
        },
        numberRowAt(0, 123),
        [],
        true
      )
    ).toBe(123)
  })

  // The endpoints are read against the scaled number. Both lines run through
  // the same two points, so a `y1` away from zero is what separates the order
  // they run in: interpolating the word itself answers 10.1 here.
  it('interpolates what the scaling factor answered, not the raw word', () => {
    const map = {
      0: {
        dataType: 'uint16' as const,
        scalingFactor: 0.1,
        interpolate: { x1: '0', x2: '100', y1: '1', y2: '11' }
      }
    }

    expect(shown(map, numberRowAt(0, 1000))).toBe(11)
  })

  // Two endpoints on the same x have no slope to read, and the division would
  // answer an Infinity.
  it('answers y1 when both endpoints sit on the same x', () => {
    const map = {
      0: { dataType: 'uint16' as const, interpolate: { x1: '1', x2: '1', y1: '7', y2: '99' } }
    }

    expect(shown(map, numberRowAt(0, 50))).toBe(7)
  })
})

describe('linearInterpolate', () => {
  // 4 to 20 mA onto 0 to 100 %, the line the field is there for.
  const milliamps = { x1: '4', x2: '20', y1: '0', y2: '100' }

  it('answers the endpoints at the endpoints', () => {
    expect(linearInterpolate(4, milliamps)).toBe(0)
    expect(linearInterpolate(20, milliamps)).toBe(100)
  })

  it('answers the point between them', () => {
    expect(linearInterpolate(12, milliamps)).toBe(50)
  })

  // Nothing clamps: a sensor below 4 mA reads negative, which is what a broken
  // loop looks like.
  it('extends the line past both endpoints', () => {
    expect(linearInterpolate(0, milliamps)).toBe(-25)
    expect(linearInterpolate(24, milliamps)).toBe(125)
  })

  it('runs a falling line', () => {
    expect(linearInterpolate(5, { x1: '0', x2: '10', y1: '100', y2: '0' })).toBe(50)
  })

  it('takes endpoints written in either order', () => {
    expect(linearInterpolate(12, { x1: '20', x2: '4', y1: '100', y2: '0' })).toBe(50)
  })
})

describe('scaleValue', () => {
  it('answers the number unscaled when there is no mapping', () => {
    expect(scaleValue('17', 'uint16', undefined)).toBe(17)
  })

  it('rounds the interpolated number to the decimals of the factor', () => {
    expect(
      scaleValue('1', 'uint16', {
        scalingFactor: 0.1,
        interpolate: { x1: '0', x2: '3', y1: '0', y2: '1' }
      })
    ).toBe(0)
  })
})
