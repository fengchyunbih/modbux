import z from 'zod'

/**
 * The four orders a 32 or 64 bit value's bytes can sit in over its registers,
 * named for 0x12345678 read as the bytes A B C D.
 *
 * Stored as two flags rather than as this name, because `littleEndian` was
 * persisted and written into config files before the other two orders existed,
 * and keeping it keeps those readable. The name is what a selector or an undo
 * step holds, since it compares with `===`.
 */
export const ByteOrderSchema = z.enum(['ABCD', 'CDAB', 'BADC', 'DCBA'])
export type ByteOrder = z.infer<typeof ByteOrderSchema>

/**
 * The byte order as the store, main and a config file keep it.
 *
 * `littleEndian` reverses the order of the words, `byteSwap` swaps the two
 * bytes inside each word. `littleBigEndian.md`, beside `encoding.ts`, puts
 * 0x12345678 through all four.
 */
export interface ByteOrderFlags {
  littleEndian: boolean
  byteSwap: boolean
}

export const byteOrderOf = ({ littleEndian, byteSwap }: ByteOrderFlags): ByteOrder =>
  littleEndian ? (byteSwap ? 'DCBA' : 'CDAB') : byteSwap ? 'BADC' : 'ABCD'

export const byteOrderFlags = (order: ByteOrder): ByteOrderFlags => ({
  littleEndian: order === 'CDAB' || order === 'DCBA',
  byteSwap: order === 'BADC' || order === 'DCBA'
})

/**
 * The byte swap a config file carries. Absent is `false`, which is what every
 * file written before Modbux could swap bytes means.
 */
export const ConfigByteSwapSchema = z.boolean().optional()
