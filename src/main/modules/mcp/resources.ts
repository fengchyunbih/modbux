import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ListResourcesResult } from '@modelcontextprotocol/sdk/types.js'
import { DEFAULT_UTF8_LENGTH } from '@shared'
import { CLIENT_CONFIG_SCHEMA, PROJECT_SCHEMA, SERVER_CONFIG_SCHEMA } from './jsonSchemas'
import { MAIN_WINDOW_CLOSED, McpToolContext } from './registry'

export const ENCODING_RESOURCE_URI = 'modbux://encoding'
export const CLIENT_CONFIG_RESOURCE_URI = 'modbux://client/config'
export const CLIENT_CONFIG_SCHEMA_URI = 'modbux://schema/client-config'
export const SERVER_CONFIG_SCHEMA_URI = 'modbux://schema/server-config'
export const PROJECT_SCHEMA_URI = 'modbux://schema/project'
export const SERVER_LIST_RESOURCE_URI = 'modbux://server/list'
export const SERVER_CONFIG_TEMPLATE = 'modbux://server/{uuid}/config'

/**
 * How Modbux reads a value out of registers, for an agent that has a point
 * table and has to say which data type, address and byte order each point is.
 *
 * Each claim here is what `conversion.ts` and `encoding.ts` in `@shared` do.
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

A client configuration has one byte order for every point, held as two flags
in \`registerConfig\`: \`littleEndian\` reverses the order of the words, and
\`byteSwap\` swaps the two bytes inside each word. \`client_read_points\`
answers the order by name as \`byteOrder\`.

| Order | littleEndian | byteSwap | 32-bit 0x12345678, words 0 and 1 | 64-bit 0x1122334455667788, words 0 to 3 |
| ----- | ------------ | -------- | -------------------------------- | ---------------------------------------- |
| ABCD  | false        | false    | 0x1234 0x5678                    | 0x1122 0x3344 0x5566 0x7788              |
| CDAB  | true         | false    | 0x5678 0x1234                    | 0x7788 0x5566 0x3344 0x1122              |
| BADC  | false        | true     | 0x3412 0x7856                    | 0x2211 0x4433 0x6655 0x8877              |
| DCBA  | true         | true     | 0x7856 0x3412                    | 0x8877 0x6655 0x4433 0x2211              |

The order applies to int32, uint32, float, unix, int64, uint64, double and
datetime. int16, uint16, bitmap and utf8 read the same in every order: a
one-register value has no words to reverse and its bytes are not swapped, and
a utf8 string is read high byte first, register by register.

## Scaling

The engineering value is the decoded number times \`scalingFactor\`, then, if
the mapping has \`interpolate\` ({x1, y1, x2, y2}), read off the line through
(x1, y1) and (x2, y2). It is rounded to the decimals the factor has, plus the
value's own decimals for float and double.

## Checking a byte order with a read

Read a point whose value you know (a voltage near 230, a frequency near 50).
If the value is absurd, decode the raw words of that point in the other three
orders; the one that gives the known value is the device's.
`

/** Every resource: the encoding notes, the live configuration and the file schemas. */
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
  const schemas = [
    [
      'client-config-schema',
      CLIENT_CONFIG_SCHEMA_URI,
      'Client config file schema',
      CLIENT_CONFIG_SCHEMA
    ],
    [
      'server-config-schema',
      SERVER_CONFIG_SCHEMA_URI,
      'Server config file schema',
      SERVER_CONFIG_SCHEMA
    ],
    ['project-schema', PROJECT_SCHEMA_URI, 'Project file schema', PROJECT_SCHEMA]
  ] as const
  for (const [name, uri, title, schema] of schemas) {
    server.registerResource(
      name,
      uri,
      {
        title,
        description: `JSON Schema (draft-07) of the ${title.toLowerCase().replace(' schema', '')} that the export and import tools exchange.`,
        mimeType: 'application/schema+json'
      },
      (resourceUri) => ({
        contents: [
          {
            uri: resourceUri.href,
            mimeType: 'application/schema+json',
            text: JSON.stringify(schema, null, 2)
          }
        ]
      })
    )
  }

  server.registerResource(
    'server-list',
    SERVER_LIST_RESOURCE_URI,
    {
      title: 'Server list',
      description: 'What server_list answers, as JSON.',
      mimeType: 'application/json'
    },
    async (uri) => {
      if (!context.mainWindowOpen()) throw new Error(MAIN_WINDOW_CLOSED)
      const list = await context.rendererCommands.send('server_list')
      return {
        contents: [
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(list, null, 2) }
        ]
      }
    }
  )

  server.registerResource(
    'server-config',
    new ResourceTemplate(SERVER_CONFIG_TEMPLATE, {
      list: async (): Promise<ListResourcesResult> => {
        if (!context.mainWindowOpen()) return { resources: [] }
        // A listing that cannot be built is an empty one: the client can
        // still read a template it already knows.
        const list = await context.rendererCommands.send('server_list').catch(() => undefined)
        return {
          resources: (list?.servers ?? []).map(({ uuid, name, port }) => ({
            uri: `modbux://server/${uuid}/config`,
            name: `Server ${name || port} config`,
            mimeType: 'application/json'
          }))
        }
      }
    }),
    {
      title: 'Server config file',
      description: 'What server_export_config answers for one server: the server config file.',
      mimeType: 'application/json'
    },
    async (uri, variables) => {
      if (!context.mainWindowOpen()) throw new Error(MAIN_WINDOW_CLOSED)
      const uuid = [variables.uuid].flat()[0] ?? ''
      const { json } = await context.rendererCommands.send('server_export_config', { uuid })
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: json }] }
    }
  )
}
