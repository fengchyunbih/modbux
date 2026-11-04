// A master writes a 32 or 64 bit register one word at a time, and the server
// store recomputes the value after each word. The word arrives in the order
// the server encodes in, so the fold has to read it back in that order.
import { describe, expect, it } from 'vitest'
import {
  byteOrderFlags,
  ByteOrder,
  ByteOrderFlags,
  convertRegisterData,
  createRegisters,
  encodeIEC870DateTime,
  ServerRegisterValue
} from '@shared'
import { foldWordIntoComposite } from '../server.zustand.helpers'

const ORDERS: ByteOrder[] = ['ABCD', 'CDAB', 'BADC', 'DCBA']

/** What the store keeps for a value: the timestamp's packed words for a datetime. */
const storedValue = (
  dataType: 'int32' | 'uint32' | 'float' | 'unix' | 'int64' | 'uint64' | 'double' | 'datetime',
  value: number
): ServerRegisterValue => {
  if (dataType === 'datetime') return encodeIEC870DateTime(value).readBigUInt64BE(0).toString()
  if (dataType === 'int64' || dataType === 'uint64') return String(value)
  return value
}

/** Every word of `next` folded over `current`, one at a time, as a master's FC6 writes land. */
const foldAll = (
  dataType: Parameters<typeof storedValue>[0],
  current: number,
  next: number,
  order: ByteOrderFlags
): ServerRegisterValue | undefined => {
  let currentValue: ServerRegisterValue | bigint = storedValue(dataType, current)
  let value: ServerRegisterValue | undefined
  for (const [offsetRegisters, word] of createRegisters(dataType, next, order).entries()) {
    const folded = foldWordIntoComposite({ currentValue, dataType, order, offsetRegisters, word })
    if (!folded) return undefined
    currentValue = folded.composite
    value = folded.value
  }
  return value
}

describe('foldWordIntoComposite in each byte order', () => {
  const CASES = [
    ['int32', -70000, 305419896],
    ['uint32', 70000, 4023233417],
    ['float', 1.5, 3.14],
    ['unix', 1600000000, 1700000000],
    ['int64', -5, -1234567890123],
    ['uint64', 7, 0x0012_3456_789a_bcde],
    ['double', 1.25, 2.718],
    ['datetime', Date.UTC(2020, 0, 2, 3, 4, 5), Date.UTC(2024, 5, 1, 12, 34, 56)]
  ] as const

  for (const order of ORDERS) {
    for (const [dataType, current, next] of CASES) {
      it(`ends on the ${dataType} a master wrote word by word in ${order}`, () => {
        expect(foldAll(dataType, current, next, byteOrderFlags(order))).toEqual(
          storedValue(dataType, next)
        )
      })
    }
  }

  // The value after one word is the one the client decodes from the registers
  // the server then holds: the new first word and the old rest.
  const SINGLE = [
    ['int32', -70000, 305419896],
    ['uint32', 70000, 4023233417],
    ['int64', -1234567890123, 81985529],
    ['uint64', 0x0012_3456_789a_bcde, 1]
  ] as const

  for (const order of ORDERS) {
    for (const [dataType, current, next] of SINGLE) {
      it(`recomputes a ${dataType} after one word in ${order} as the client reads it`, () => {
        const flags = byteOrderFlags(order)
        const [word] = createRegisters(dataType, next, flags)
        const [, ...kept] = createRegisters(dataType, current, flags)
        const folded = foldWordIntoComposite({
          currentValue: storedValue(dataType, current),
          dataType,
          order: flags,
          offsetRegisters: 0,
          word
        })

        const registers = [word, ...kept]
        const buffer = Buffer.alloc(registers.length * 2)
        for (const [i, register] of registers.entries()) buffer.writeUInt16BE(register, i * 2)
        const read = convertRegisterData({ data: registers, buffer }, 0, flags, false)[0]

        expect(String(folded?.value)).toBe(String(read?.words?.[dataType]))
      })
    }
  }

  it('leaves a 16 bit word as it was written in every order', () => {
    for (const order of ORDERS) {
      const folded = foldWordIntoComposite({
        currentValue: 1,
        dataType: 'uint16',
        order: byteOrderFlags(order),
        offsetRegisters: 0,
        word: 0x1234
      })
      expect(folded?.value).toBe(0x1234)
    }
  })
})
