import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { DEFAULT_UTF8_LENGTH } from '@shared'
import { MAIN_WINDOW_CLOSED, McpToolContext } from './registry'

export const ENCODING_RESOURCE_URI = 'modbux://encoding'
export const CLIENT_CONFIG_RESOURCE_URI = 'modbux://client/config'

/**
 * How Modbux reads a value out of registers, for an agent that has a point
 * table and has to say which data type, address and byte order each point is.
 *
 * Each claim here is what `conversion.ts` and `encoding.ts` in `@shared` do.
 * The byte order section says ABCD and CDAB only, because those two are what a
 * configuration can hold until byte swap ships (design step 6).
 */
export const ENCODING_NOTES = `# How Modbux encodes values

## Addresses

- Every address a Modbux tool takes or answers is the PDU address: the number
  that goes on the wire, starting at 0.
- The client's address base (\`registerConfig.addressBase\`, "0" or "1") changes
  only what the grid shows: it shows the PDU address plus the base.
  \`client_read_points\` answers both, as \`address\` and \`displayAddress\`.
- A point table written in Modicon notation (40001, 30001, ...) names the
  holding register at PDU address 40001 - 40001 = 0, the input register at
  30001 - 30001 = 0, and so on. A table that says "register 1" usually means
  PDU address 0; check it with a read.

## Register types

| Register type     | Function code (read) | Unit       |
| ----------------- | -------------------- | ---------- |
| coils             | FC01                 | 1 bit      |
| discrete_inputs   | FC02                 | 1 bit      |
| holding_registers | FC03                 | 16-bit word |
| input_registers   | FC04                 | 16-bit word |

## Data types and widths

| Data type | Registers | Notes |
| --------- | --------- | ----- |
| int16     | 1 | signed |
| uint16    | 1 | unsigned |
| bitmap    | 1 | the 16 bits of one word, shown per bit |
| int32     | 2 | signed |
| uint32    | 2 | unsigned |
| float     | 2 | IEEE 754 single precision, shown rounded to 5 decimals |
| unix      | 2 | uint32 seconds since 1970-01-01 UTC, shown as yyyy/MM/dd HH:mm:ss |
| int64     | 4 | signed |
| uint64    | 4 | unsigned |
| double    | 4 | IEEE 754 double precision, shown rounded to 10 decimals |
| datetime  | 4 | IEC 870-5 date and time, shown as yyyy/MM/dd HH:mm:ss (UTC) |
| utf8      | ${DEFAULT_UTF8_LENGTH} by default | two characters per register, high byte first; a 0 byte reads as a space |

A value of more than one register starts at its own address and takes the
addresses after it. A mapping gives a data type to the first address only.

## Byte order

Within one 16-bit word the high byte is always first. Across the words of a
32-bit or 64-bit value the client has one setting, \`registerConfig.littleEndian\`:

| littleEndian | Order | 32-bit value 0x12345678 on the wire |
| ------------ | ----- | ----------------------------------- |
| false        | ABCD  | word 0 = 0x1234, word 1 = 0x5678 |
| true         | CDAB  | word 0 = 0x5678, word 1 = 0x1234 |

For a 64-bit value, \`true\` reverses all four words. 16-bit types and utf8 are
not affected. One configuration has one byte order for every point.

BADC and DCBA (a byte swap inside each word) cannot be configured yet.

## Scaling

The engineering value is the decoded number times \`scalingFactor\`, then, if
the mapping has \`interpolate\` ({x1, y1, x2, y2}), read off the line through
(x1, y1) and (x2, y2). It is rounded to the decimals the factor has, plus the
value's own decimals for float and double.

## Checking a byte order with a read

Read a point whose value you know (a voltage near 230, a frequency near 50).
If the value is absurd and the swapped word pair would give the known value,
the byte order is the other one.
`

/** The two resources this step ships: the encoding notes and the client config. */
export const registerResources = (server: McpServer, context: McpToolContext): void => {
  server.registerResource(
    'encoding',
    ENCODING_RESOURCE_URI,
    {
      title: 'How Modbux encodes values',
      description: 'Addresses, register types, data type widths, byte order and scaling.',
      mimeType: 'text/markdown'
    },
    (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: ENCODING_NOTES }] })
  )

  server.registerResource(
    'client-config',
    CLIENT_CONFIG_RESOURCE_URI,
    {
      title: 'Current client configuration',
      description: 'What client_get_config answers, as JSON.',
      mimeType: 'application/json'
    },
    async (uri) => {
      // A resource has no error result, so a refusal is a thrown error, which
      // the SDK answers as a JSON-RPC error carrying this message.
      if (!context.mainWindowOpen()) throw new Error(MAIN_WINDOW_CLOSED)
      const config = await context.rendererCommands.send('client_get_config')
      return {
        contents: [
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(config, null, 2) }
        ]
      }
    }
  )
}
