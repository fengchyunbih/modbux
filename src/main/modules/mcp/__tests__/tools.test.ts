/* eslint-disable @typescript-eslint/explicit-function-return-type */
// The tools and resources as an MCP client sees them, over the SDK's in-memory
// transport: the server is the real `createMcpServer`, and what it reaches is
// a stand-in client and stand-in renderer commands.
import { describe, expect, it } from 'vitest'
import z from 'zod'
import {
  ByteOrder,
  ByteOrderFlags,
  ByteOrderSchema,
  byteOrderFlags,
  convertBitData,
  convertRegisterData,
  createRegisters,
  emptyRegisterMapping
} from '@shared'
import { RendererCommandError } from '../../rendererCommands'
import { defineTool, MAIN_WINDOW_CLOSED, toolResult, WRITES_NOT_ALLOWED } from '../registry'
import { CLIENT_CONFIG_RESOURCE_URI, ENCODING_NOTES, ENCODING_RESOURCE_URI } from '../resources'
import { CONFIG, connectInMemory, fakeContext, jsonOf, textOf } from './fakeContext'

/** Registers as modbus-serial answers them, converted the way `_read` does. */
const holdingRows = (
  address: number,
  words: number[],
  order: ByteOrderFlags = { littleEndian: false, byteSwap: false }
) => {
  const buffer = Buffer.alloc(words.length * 2)
  words.forEach((word, i) => buffer.writeUInt16BE(word, i * 2))
  return convertRegisterData({ data: words, buffer }, address, order, false)
}

/** The words the encoding notes give for 0x12345678 in each order. */
const UINT32_WORDS: Record<ByteOrder, number[]> = {
  ABCD: [0x1234, 0x5678],
  CDAB: [0x5678, 0x1234],
  BADC: [0x3412, 0x7856],
  DCBA: [0x7856, 0x3412]
}

describe('the tool list', () => {
  it('lists the four client tools with their annotations', async () => {
    const client = await connectInMemory(fakeContext())

    const { tools } = await client.listTools()

    expect(tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint])).toEqual([
      ['client_get_config', true],
      ['client_connect', false],
      ['client_disconnect', false],
      ['client_read_points', true]
    ])
    // Connecting talks to a device and changes nothing it holds.
    for (const tool of tools) expect(tool.annotations?.destructiveHint ?? false).toBe(false)
    expect(tools.find((tool) => tool.name === 'client_read_points')?.annotations).toMatchObject({
      openWorldHint: true
    })
  })
})

describe('every tool, with the main window closed', () => {
  it.each(['client_get_config', 'client_connect', 'client_disconnect', 'client_read_points'])(
    '%s answers an error and reaches nothing',
    async (name) => {
      const context = fakeContext()
      context.setClientState({ connectState: 'connected' })
      context.setMainWindowOpen(false)
      const client = await connectInMemory(context)

      const result = await client.callTool({ name, arguments: {} })

      expect(result.isError).toBe(true)
      expect(textOf(result)).toBe(MAIN_WINDOW_CLOSED)
      expect(context.send).not.toHaveBeenCalled()
      expect(context.read).not.toHaveBeenCalled()
    }
  )
})

describe('client_get_config', () => {
  it('answers the window’s configuration and main’s connect state', async () => {
    const context = fakeContext()
    context.setClientState({ connectState: 'connected' })
    const client = await connectInMemory(context)

    const result = await client.callTool({ name: 'client_get_config', arguments: {} })

    expect(result.isError).toBeUndefined()
    expect(jsonOf(result)).toEqual({ ...CONFIG, connectState: 'connected' })
    expect(context.send).toHaveBeenCalledWith('client_get_config')
  })

  it('answers the command’s failure as an error', async () => {
    const context = fakeContext({
      client_get_config: () =>
        Promise.reject(new RendererCommandError('timeout', 'client_get_config: no answer'))
    })
    const client = await connectInMemory(context)

    const result = await client.callTool({ name: 'client_get_config', arguments: {} })

    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('client_get_config: no answer')
  })
})

describe('client_connect', () => {
  it('answers connected once the command has run and main connected', async () => {
    const context = fakeContext({
      client_connect: async () => {
        context.setClientState({ connectState: 'connected' })
        return { outcome: 'requested' }
      }
    })
    const client = await connectInMemory(context)

    const result = await client.callTool({ name: 'client_connect', arguments: {} })

    expect(result.isError).toBeUndefined()
    expect(jsonOf(result)).toEqual({ connectState: 'connected' })
  })

  it('answers the reason main gave when the connect failed', async () => {
    const context = fakeContext({
      client_connect: async () => {
        context.setLastConnectError('Connection refused at 192.168.1.10:502')
        return { outcome: 'requested' }
      }
    })
    const client = await connectInMemory(context)

    const result = await client.callTool({ name: 'client_connect', arguments: {} })

    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe(
      'Not connected (disconnected): Connection refused at 192.168.1.10:502'
    )
  })

  it('sends nothing when already connected', async () => {
    const context = fakeContext()
    context.setClientState({ connectState: 'connected' })
    const client = await connectInMemory(context)

    const result = await client.callTool({ name: 'client_connect', arguments: {} })

    expect(result.isError).toBeUndefined()
    expect(jsonOf(result)).toEqual({ connectState: 'connected', message: 'Already connected' })
    expect(context.send).not.toHaveBeenCalled()
  })

  it.each([
    ['no_address', 'The client has no host (TCP) or COM port (RTU) set.'],
    ['serial_access_blocked', 'This user may not open serial ports.'],
    ['not_disconnected', 'The client is disconnected; wait for it to finish']
  ])('answers %s as an error saying why', async (outcome, message) => {
    const context = fakeContext({ client_connect: async () => ({ outcome }) })
    const client = await connectInMemory(context)

    const result = await client.callTool({ name: 'client_connect', arguments: {} })

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain(message)
  })
})

describe('client_disconnect', () => {
  it('answers the state main ends in', async () => {
    const context = fakeContext({
      client_disconnect: async () => {
        context.setClientState({ connectState: 'disconnected' })
        return { outcome: 'requested' }
      }
    })
    context.setClientState({ connectState: 'connected' })
    const client = await connectInMemory(context)

    const result = await client.callTool({ name: 'client_disconnect', arguments: {} })

    expect(jsonOf(result)).toEqual({ connectState: 'disconnected' })
    expect(context.send).toHaveBeenCalledWith('client_disconnect')
  })

  it('sends nothing when already disconnected', async () => {
    const context = fakeContext()
    const client = await connectInMemory(context)

    const result = await client.callTool({ name: 'client_disconnect', arguments: {} })

    expect(jsonOf(result)).toEqual({
      connectState: 'disconnected',
      message: 'Already disconnected'
    })
    expect(context.send).not.toHaveBeenCalled()
  })

  it('answers an error while main is disconnecting', async () => {
    const context = fakeContext({ client_disconnect: async () => ({ outcome: 'not_connected' }) })
    context.setClientState({ connectState: 'disconnecting' })
    const client = await connectInMemory(context)

    const result = await client.callTool({ name: 'client_disconnect', arguments: {} })

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('The client is disconnecting')
  })
})

describe('client_read_points', () => {
  const connected = () => {
    const context = fakeContext()
    context.setClientState({ connectState: 'connected' })
    return context
  }

  it('answers each address with its word, and the mapped ones with their value', async () => {
    const context = connected()
    context.appState.registerConfig.addressBase = '1'
    const mapping = emptyRegisterMapping()
    // 0x4369 0x0000 is 233 as a big endian float, and 2301 * 0.1 is 230.1.
    mapping.holding_registers[10] = { dataType: 'float', comment: 'Voltage L1' }
    mapping.holding_registers[12] = { dataType: 'uint16', scalingFactor: 0.1, comment: 'U' }
    context.setMapping(mapping)
    context.read.mockResolvedValue({
      read: true,
      data: holdingRows(10, [0x4369, 0x0000, 2301]),
      groups: [[10, 3]],
      errors: []
    })
    const client = await connectInMemory(context)

    const answer = jsonOf(await client.callTool({ name: 'client_read_points', arguments: {} }))

    expect(answer).toMatchObject({
      unitId: 7,
      registerType: 'holding_registers',
      addressBase: 1,
      byteOrder: 'ABCD',
      errors: []
    })
    expect(answer.rows).toEqual([
      {
        address: 10,
        displayAddress: 11,
        word: 0x4369,
        hex: '4369',
        dataType: 'float',
        comment: 'Voltage L1',
        value: 233
      },
      { address: 11, displayAddress: 12, word: 0, hex: '0000' },
      {
        address: 12,
        displayAddress: 13,
        word: 2301,
        hex: '08fd',
        dataType: 'uint16',
        scalingFactor: 0.1,
        comment: 'U',
        value: 230.1
      }
    ])
  })

  it.each(ByteOrderSchema.options)('decodes and names the byte order %s', async (order) => {
    const context = connected()
    Object.assign(context.appState.registerConfig, byteOrderFlags(order))
    const mapping = emptyRegisterMapping()
    mapping.holding_registers[0] = { dataType: 'uint32' }
    context.setMapping(mapping)
    context.read.mockResolvedValue({
      read: true,
      data: holdingRows(0, UINT32_WORDS[order], byteOrderFlags(order)),
      groups: [[0, 2]],
      errors: []
    })
    const client = await connectInMemory(context)

    const answer = jsonOf(await client.callTool({ name: 'client_read_points', arguments: {} }))

    expect(answer.byteOrder).toBe(order)
    expect((answer.rows as { value?: number }[])[0]?.value).toBe(0x12345678)
  })

  it('answers a bit for coils', async () => {
    const context = connected()
    context.appState.registerConfig.type = 'coils'
    context.read.mockResolvedValue({
      read: true,
      data: convertBitData({ data: [true, false], buffer: Buffer.from([1]) }, 4, 2, false),
      groups: [[4, 2]],
      errors: []
    })
    const client = await connectInMemory(context)

    const answer = jsonOf(await client.callTool({ name: 'client_read_points', arguments: {} }))

    expect(answer.rows).toEqual([
      { address: 4, displayAddress: 4, bit: true },
      { address: 5, displayAddress: 5, bit: false }
    ])
  })

  it('reads nothing while disconnected', async () => {
    const context = fakeContext()
    const client = await connectInMemory(context)

    const result = await client.callTool({ name: 'client_read_points', arguments: {} })

    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('The client is not connected. Call client_connect first.')
    expect(context.read).not.toHaveBeenCalled()
  })

  it('reads nothing during a poll, and says so', async () => {
    const context = connected()
    context.setClientState({ polling: true })
    const client = await connectInMemory(context)

    const result = await client.callTool({ name: 'client_read_points', arguments: {} })

    expect(textOf(result)).toBe('Cannot read during a poll. Try again once it has finished.')
    expect(context.read).not.toHaveBeenCalled()
  })

  it.each([
    ['busy', 'The client is busy with another request.'],
    ['not_connected', 'The client is not connected.'],
    ['superseded', 'The client configuration changed while the read was on the wire']
  ] as const)('answers a read refused as %s with an error', async (reason, message) => {
    const context = connected()
    context.read.mockResolvedValue({ read: false, reason })
    const client = await connectInMemory(context)

    const result = await client.callTool({ name: 'client_read_points', arguments: {} })

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain(message)
  })

  it('answers the rows of a read where one group of two failed, as a success', async () => {
    const context = connected()
    context.read.mockResolvedValue({
      read: true,
      data: holdingRows(0, [5]),
      groups: [
        [0, 1],
        [100, 1]
      ],
      errors: [{ group: [100, 1], message: 'Illegal data address' }]
    })
    const client = await connectInMemory(context)

    const result = await client.callTool({ name: 'client_read_points', arguments: {} })

    expect(result.isError).toBeUndefined()
    expect(jsonOf(result).errors).toEqual([
      { address: 100, length: 1, message: 'Illegal data address' }
    ])
  })

  it('answers a read where every group failed as an error, with the reasons', async () => {
    const context = connected()
    context.read.mockResolvedValue({
      read: true,
      data: [],
      groups: [[0, 1]],
      errors: [{ group: [0, 1], message: 'Timed out' }]
    })
    const client = await connectInMemory(context)

    const result = await client.callTool({ name: 'client_read_points', arguments: {} })

    expect(result.isError).toBe(true)
    expect(jsonOf(result).errors).toEqual([{ address: 0, length: 1, message: 'Timed out' }])
  })
})

describe('a tool that writes to a device', () => {
  const writer = defineTool({
    name: 'test_write',
    title: 'Write',
    description: 'A write',
    inputSchema: { value: z.number() },
    annotations: { readOnlyHint: false, destructiveHint: true },
    writesToDevice: true,
    run: async ({ value }) => toolResult({ wrote: value })
  })

  it('is refused while writes are not allowed', async () => {
    const result = await writer.call({ value: 1 }, fakeContext())

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: WRITES_NOT_ALLOWED }])
  })

  it('runs once writes are allowed', async () => {
    const context = { ...fakeContext(), allowWrites: () => true }

    expect(await writer.call({ value: 1 }, context)).toEqual(toolResult({ wrote: 1 }))
  })

  it('refuses arguments its schema refuses', async () => {
    const context = { ...fakeContext(), allowWrites: () => true }

    const result = await writer.call({ value: 'one' }, context)

    expect(result.isError).toBe(true)
  })

  it('cannot be defined without destructiveHint', () => {
    expect(() =>
      defineTool({
        name: 'test_unmarked',
        title: 'Write',
        description: 'A write',
        inputSchema: {},
        annotations: { readOnlyHint: false },
        writesToDevice: true,
        run: async () => toolResult({})
      })
    ).toThrow('test_unmarked writes to a device and does not say destructiveHint')
  })
})

describe('the resources', () => {
  it('lists the encoding notes and the client config', async () => {
    const client = await connectInMemory(fakeContext())

    const { resources } = await client.listResources()

    expect(resources.map((resource) => resource.uri)).toEqual([
      ENCODING_RESOURCE_URI,
      CLIENT_CONFIG_RESOURCE_URI
    ])
  })

  it('answers the encoding notes as markdown', async () => {
    const client = await connectInMemory(fakeContext())

    const { contents } = await client.readResource({ uri: ENCODING_RESOURCE_URI })

    expect(contents).toEqual([
      {
        uri: ENCODING_RESOURCE_URI,
        mimeType: 'text/markdown',
        text: expect.stringContaining('| float     | 2 |')
      }
    ])
  })

  // The table is prose an agent acts on, so its words are checked against the encoder.
  it.each(ByteOrderSchema.options)('gives the words createRegisters lays out for %s', (order) => {
    const words = createRegisters('uint32', 0x12345678, byteOrderFlags(order))
    const hex = words.map((word) => `0x${word.toString(16).padStart(4, '0')}`).join(' ')

    expect(ENCODING_NOTES).toContain(`| ${order}  |`)
    expect(ENCODING_NOTES).toMatch(new RegExp(`\\| ${order} .*\\| ${hex} `))
  })

  it('answers the client config as JSON', async () => {
    const client = await connectInMemory(fakeContext())

    const { contents } = await client.readResource({ uri: CLIENT_CONFIG_RESOURCE_URI })

    expect(contents).toEqual([
      {
        uri: CLIENT_CONFIG_RESOURCE_URI,
        mimeType: 'application/json',
        text: JSON.stringify(CONFIG, null, 2)
      }
    ])
  })

  it('refuses the client config with the main window closed', async () => {
    const context = fakeContext()
    context.setMainWindowOpen(false)
    const client = await connectInMemory(context)

    await expect(client.readResource({ uri: CLIENT_CONFIG_RESOURCE_URI })).rejects.toThrow(
      MAIN_WINDOW_CLOSED
    )
    expect(context.send).not.toHaveBeenCalled()
  })
})
