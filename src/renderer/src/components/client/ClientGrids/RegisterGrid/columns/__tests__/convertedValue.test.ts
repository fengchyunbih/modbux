import { describe, it, expect, vi } from 'vitest'
import type { RegisterData, RegisterMapObject } from '@shared'

// ─── Store stub ──────────────────────────────────────────────────────
// The column reads the address groups the last read was made of, and the real
// store subscribes to main on import.

const dataState = { addressGroups: [] as [number, number][] }

vi.mock('@renderer/context/data.zustand', () => ({
  useDataZustand: Object.assign(
    (selector: (state: typeof dataState) => unknown) => selector(dataState),
    { getState: () => dataState }
  )
}))

import { convertedValueColumn } from '../convertedValue'

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
    utf8: Buffer.from(utf8)
  },
  bit: false,
  isScanned: false
})

/** A row carrying one number, under every type that reads it as one. */
const numberRowAt = (address: number, value: number): RegisterData => ({
  ...rowAt(address, ''),
  words: {
    int16: value,
    uint16: value,
    int32: 0,
    uint32: 0,
    float: value,
    unix: '',
    int64: BigInt(0),
    uint64: BigInt(0),
    double: value,
    datetime: '',
    utf8: new Uint8Array()
  }
})

/**
 * What the value column shows, or a failure saying the column has no getter.
 *
 * The field is `value` and `RegisterData` has no such key, so the grid types the
 * first argument `never` and the getter reads the row instead. The api ref is
 * the same: the getter takes it and never touches it.
 */
const shownValue = (
  registerMap: RegisterMapObject,
  row: RegisterData,
  showRaw = false
): unknown => {
  const column = convertedValueColumn(registerMap, showRaw)
  const { valueGetter } = column
  if (!valueGetter) throw new Error('the value column has no valueGetter')

  return valueGetter(undefined as never, row, column, undefined as never)
}

// The conversion itself is `engineeringValue`, tested in
// `src/shared/__tests__/engineeringValue.test.ts`. What is left here is what
// the column adds: the groups it reads out of the data store, and the raw flag
// it passes on.
describe('what the value column hands the conversion', () => {
  // The group is [address, address + length), so four registers hold eight
  // characters and the ninth belongs to whatever was read after them.
  it('cuts a string to the group the data store holds', () => {
    dataState.addressGroups = [[0, 4]]

    expect(shownValue({ 0: { dataType: 'utf8' } }, rowAt(0, 'ABCDEFGHIJKL'))).toBe('ABCDEFGH')
  })

  it('shows nothing for a string when the data store holds no group', () => {
    dataState.addressGroups = []

    expect(shownValue({ 0: { dataType: 'utf8' } }, rowAt(0, 'ABCDEFGHIJKL'))).toBe(undefined)
  })

  it('scales the word when the toolbar does not ask for raw', () => {
    expect(shownValue({ 0: { dataType: 'uint16', scalingFactor: 0.1 } }, numberRowAt(0, 123))).toBe(
      12.3
    )
  })

  it('shows the word itself when the toolbar asks for raw', () => {
    expect(
      shownValue({ 0: { dataType: 'uint16', scalingFactor: 0.1 } }, numberRowAt(0, 123), true)
    ).toBe(123)
  })
})
