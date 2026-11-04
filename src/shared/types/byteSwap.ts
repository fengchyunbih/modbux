import z from 'zod'

/**
 * The byte swap a config file may carry, reserved before Modbux can apply one.
 *
 * Absent means `false`. The design in `docs/design/json-config-and-mcp.md`
 * opens `true` in a later step, where each 16 bit word of a 32 or 64 bit value
 * has its two bytes swapped (BADC and DCBA). Until then a file asking for it is
 * refused by name: a `z.object` strips a key it does not declare, so without
 * this the file would open and every such value would read in the wrong order.
 */
export const ReservedByteSwapSchema = z
  .literal(false, {
    // `message` is not read by `z.literal` at zod 3.25.76; `errorMap` is.
    errorMap: () => ({
      message: 'byte swap (BADC or DCBA) is not supported by this version of Modbux'
    })
  })
  .optional()
