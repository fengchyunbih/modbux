import { ByteOrder } from '@shared'

/**
 * The four byte orders a selector offers, with the suffix each button's
 * `data-testid` carries. ABCD and CDAB keep the `be` and `le` the two buttons
 * had before byte swap existed, which is what the e2e specs address them by.
 */
export const BYTE_ORDER_OPTIONS: readonly { order: ByteOrder; testId: string; title: string }[] = [
  { order: 'ABCD', testId: 'be', title: 'High word first, high byte first (Modbus standard)' },
  { order: 'CDAB', testId: 'le', title: 'Low word first, high byte first' },
  { order: 'BADC', testId: 'badc', title: 'High word first, low byte first' },
  { order: 'DCBA', testId: 'dcba', title: 'Low word first, low byte first' }
]
