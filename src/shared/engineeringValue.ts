import round from 'lodash/round'
import type {
  AddressGroup,
  DataType,
  RegisterData,
  RegisterLinearInterpolation,
  RegisterMapObject,
  RegisterMapValue
} from './types'

/**
 * The line through `(x1, y1)` and `(x2, y2)`, read at `x`.
 *
 * The endpoints are strings because the mapping stores what the user typed.
 * Two endpoints on the same x have no slope to read, and the division would
 * answer an Infinity, so that line answers `y1` everywhere.
 */
export const linearInterpolate = (
  x: number,
  { x1, x2, y1, y2 }: RegisterLinearInterpolation
): number => {
  const nx1 = Number(x1)
  const nx2 = Number(x2)
  const ny1 = Number(y1)
  const ny2 = Number(y2)

  if (nx2 === nx1) return ny1

  const t = (x - nx1) / (nx2 - nx1)
  return ny1 + t * (ny2 - ny1)
}

/**
 * A decoded number scaled by the mapping's factor, then interpolated, then
 * rounded to the decimals those two introduce.
 *
 * The interpolation reads the scaled number, not the word: the endpoints are
 * written in the unit the factor produces.
 *
 * The precision is the factor's decimals, plus the value's own for a `float` or
 * a `double`: `3 * 0.1` is `0.30000000000000004` in JavaScript, and a float
 * rounded to the factor's count alone loses its own decimals.
 */
export const scaleValue = (
  value: string,
  dataType: DataType | undefined,
  mapValue: RegisterMapValue | undefined
): number => {
  const scalingFactor = mapValue?.scalingFactor ?? 1
  const decimalPlaces = String(scalingFactor).split('.')[1]?.length ?? 0

  const float = dataType === 'float' || dataType === 'double'
  const decimalPlacesFloat = float ? (value.split('.')[1]?.length ?? 0) : 0

  let scaledValue = Number(value) * scalingFactor

  const interpolate = mapValue?.interpolate
  if (interpolate) scaledValue = linearInterpolate(scaledValue, interpolate)

  return round(scaledValue, decimalPlaces + decimalPlacesFloat)
}

/**
 * The value the client grid shows for a row: the word the mapping's data type
 * picks out of the row, scaled and interpolated, or the string for the types
 * that read as one.
 *
 * `undefined` is "nothing to show": a row that failed, an address the mapping
 * gives no type, a row that carries no words, a word that is not a number, or
 * a utf8 address outside every group the read was made of.
 *
 * `addressGroups` is what the read asked for, because a utf8 string runs to the
 * next typed register or to the end of its group, whichever is first.
 * `showRaw` answers the decoded word without the factor or the interpolation.
 */
export const engineeringValue = (
  row: RegisterData,
  registerMap: RegisterMapObject,
  addressGroups: readonly AddressGroup[],
  showRaw: boolean
): number | string | undefined => {
  if (row.error) return undefined
  const address = row.id

  const dataType = registerMap[address]?.dataType

  // The word is read before it is stringified, because `String(undefined)` is
  // the word "undefined", which is truthy, so a row carrying no words drew that
  // in the cell. `convertBitData` writes such a row for every coil and discrete
  // input, and those rows outlive a switch of the register type while a read
  // loop owns the grid. A UTF-8 register drew the same word cut to the group it
  // sits in, which is `"undefine"` over four registers.
  const word = dataType && dataType !== 'none' ? row.words?.[dataType] : undefined
  if (word === undefined || word === '') return undefined
  const value = String(word)

  if (dataType === 'utf8') return utf8Value(value, address, registerMap, addressGroups)

  if (dataType === 'datetime' || dataType === 'unix') return value

  if (isNaN(Number(value))) return undefined

  if (showRaw) return Number(value)

  return scaleValue(value, dataType, registerMap[address])
}

/**
 * The part of a utf8 word that belongs to the register at `address`: two
 * characters per register, up to the next register the mapping gives a type,
 * the length the mapping names or the end of the group, whichever comes first.
 *
 * The group is [startAddress, + length), the same half-open range the `find`
 * reads it as, and `<=` took two characters out of whatever was read after it.
 */
const utf8Value = (
  value: string,
  address: number,
  registerMap: RegisterMapObject,
  addressGroups: readonly AddressGroup[]
): string | undefined => {
  const currentGroup = addressGroups.find(
    ([groupAddress, length]) => address >= groupAddress && address < groupAddress + length
  )
  if (!currentGroup) return undefined
  const [startAddress, length] = currentGroup

  const named = registerMap[address]?.length ?? Infinity
  let count = 1
  let register = registerMap[address + count]
  while (
    address + count < startAddress + length &&
    count < named &&
    (!register || register.dataType === 'none' || !register.dataType)
  ) {
    count++
    register = registerMap[address + count]
  }

  return value.slice(0, count * 2)
}
