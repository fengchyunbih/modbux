/* eslint-disable @typescript-eslint/explicit-function-return-type */
// The point table tools as an MCP client sees them, over the SDK's in-memory
// transport, with the client and the renderer commands stood in for.
import { describe, expect, it } from 'vitest'
import {
  byteOrderFlags,
  createRegisters,
  defaultConnectionConfig,
  defaultRegisterConfig,
  ServerList,
  ServerValues
} from '@shared'
import { WRITES_NOT_ALLOWED } from '../registry'
import { CommandAnswers, connectInMemory, fakeContext, jsonOf, textOf } from './fakeContext'

const SERVERS: ServerList = {
  selectedUuid: 'main',
  servers: [
    { uuid: 'main', port: '502', unitId: '0' },
    { uuid: 'sim', name: 'Meter', port: '503', unitId: '2' }
  ]
}

/** What `server_get_values` answers for the simulator, in CDAB. */
const SIM_VALUES: ServerValues = {
  uuid: 'sim',
  port: '503',
  byteOrder: 'CDAB',
  units: {
    '2': {
      coils: { 4: { value: true, comment: 'Run' } },
      discrete_inputs: {},
      input_registers: {
        0: {
          value: 0,
          params: {
            address: 0,
            registerType: 'input_registers',
            dataType: 'utf8',
            comment: 'Serial',
            value: 0,
            stringValue: 'AB',
            length: 2
          }
        }
      },
      holding_registers: {
        0: {
          value: 2305,
          params: {
            address: 0,
            registerType: 'holding_registers',
            dataType: 'float',
            comment: 'Voltage',
            value: 2305
          }
        },
        2: {
          value: '-2',
          params: {
            address: 2,
            registerType: 'holding_registers',
            dataType: 'int64',
            comment: 'Energy',
            value: -2
          }
        },
        6: {
          value: 7,
          params: {
            address: 6,
            registerType: 'holding_registers',
            dataType: 'uint16',
            comment: 'Level',
            min: 0,
            max: 10,
            interval: 1000
          }
        }
      }
    },
    '3': {
      coils: {},
      discrete_inputs: { 0: { value: false } },
      input_registers: {},
      holding_registers: {}
    }
  }
}

const serverContext = (answers: CommandAnswers = {}) =>
  fakeContext({
    server_list: async () => SERVERS,
    server_get_values: async () => SIM_VALUES,
    ...answers
  })

/** The payload of the last `name` command sent, or a failure naming it. */
const sentPayload = (context: ReturnType<typeof fakeContext>, name: string): unknown => {
  const call = context.send.mock.calls.filter(([sent]) => sent === name).at(-1)
  if (!call) throw new Error(`${name} was not sent`)
  return call[1]
}

const commandNames = (context: ReturnType<typeof fakeContext>): unknown[] =>
  context.send.mock.calls.map(([name]) => name)

describe('the point table tools in the tool list', () => {
  it('lists them with their annotations, the four that change something as destructive', async () => {
    const client = await connectInMemory(fakeContext())

    const { tools } = await client.listTools()
    const names = [
      'client_set_connection',
      'client_apply_point_table',
      'client_write',
      'server_apply_point_table',
      'server_set_values',
      'server_get_values'
    ]

    expect(
      tools
        .filter((tool) => names.includes(tool.name))
        .map((tool) => [
          tool.name,
          tool.annotations?.readOnlyHint ?? false,
          tool.annotations?.destructiveHint ?? false
        ])
    ).toEqual([
      ['client_set_connection', false, false],
      ['client_apply_point_table', false, true],
      ['client_write', false, true],
      ['server_apply_point_table', false, true],
      ['server_set_values', false, true],
      ['server_get_values', true, false]
    ])
  })
})

describe('client_set_connection', () => {
  it('sends the fields asked for and answers the connection the client holds', async () => {
    const connectionConfig = {
      ...defaultConnectionConfig,
      tcp: { host: '10.0.0.5', options: { port: 1502 } }
    }
    const context = fakeContext({
      client_set_connection: async () => ({ outcome: 'done', connectionConfig })
    })
    const client = await connectInMemory(context)

    const result = await client.callTool({
      name: 'client_set_connection',
      arguments: { tcp: { host: '10.0.0.5', options: { port: 1502 } } }
    })

    expect(result.isError).toBeFalsy()
    expect(sentPayload(context, 'client_set_connection')).toEqual({
      tcp: { host: '10.0.0.5', options: { port: 1502 } }
    })
    expect(jsonOf(result)).toEqual({ connectionConfig, connectState: 'disconnected' })
  })

  it.each([
    [
      'refused-connected',
      'The client is connected, and these settings change the connection. Call client_disconnect first.'
    ],
    ['refused', 'Modbux refused a setting, so the configuration before it is kept.']
  ] as const)('answers %s as an error', async (outcome, message) => {
    const context = fakeContext({
      client_set_connection: async () => ({
        outcome,
        connectionConfig: defaultConnectionConfig
      })
    })
    const client = await connectInMemory(context)

    const result = await client.callTool({
      name: 'client_set_connection',
      arguments: { protocol: 'ModbusRtu' }
    })

    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe(message)
  })
})

describe('client_apply_point_table', () => {
  const TABLE = [
    {
      name: 'Voltage',
      address: 40001,
      dataType: 'float',
      byteOrder: 'CDAB',
      scalingFactor: 0.1,
      unit: 'V'
    },
    { name: 'Energy', address: 40003, dataType: 'int32', byteOrder: 'CDAB' },
    { name: 'Swapped', address: 40005, dataType: 'int16', byteOrder: 'BADC' }
  ]

  const applied = () =>
    fakeContext({
      client_apply_point_table: async (payload) => ({
        outcome: 'done',
        registerConfig: { ...defaultRegisterConfig, littleEndian: true },
        unitId: (payload as { unitId?: number }).unitId ?? 0
      })
    })

  it('answers the report on a dry run and sends nothing', async () => {
    const context = applied()
    const client = await connectInMemory(context)

    const result = await client.callTool({
      name: 'client_apply_point_table',
      arguments: { points: TABLE, notation: 'modicon', dryRun: true }
    })

    expect(context.send).not.toHaveBeenCalled()
    const answer = jsonOf(result)
    expect(answer).toMatchObject({
      dryRun: true,
      applied: false,
      window: { type: 'holding_registers', address: 0, length: 4 },
      report: { byteOrder: 'CDAB', accepted: 2, rejected: 1 }
    })
  })

  it('sends the mapping, the window, the byte order and the unit id of the accepted points', async () => {
    const context = applied()
    const client = await connectInMemory(context)

    const result = await client.callTool({
      name: 'client_apply_point_table',
      arguments: { points: TABLE, notation: 'modicon', unitId: 5 }
    })

    expect(result.isError).toBeFalsy()
    expect(sentPayload(context, 'client_apply_point_table')).toEqual({
      registerMapping: {
        coils: {},
        discrete_inputs: {},
        input_registers: {},
        holding_registers: {
          0: { comment: 'Voltage [V]', dataType: 'float', scalingFactor: 0.1 },
          2: { comment: 'Energy', dataType: 'int32' }
        }
      },
      window: { type: 'holding_registers', address: 0, length: 4 },
      byteOrder: 'CDAB',
      unitId: 5
    })
    const answer = jsonOf(result)
    expect(answer).toMatchObject({ applied: true, byteOrder: 'CDAB', unitId: 5 })
    expect((answer.report as { points: { reason?: string }[] }).points[2]?.reason).toBe(
      'Byte order BADC swaps bytes, which applies to 32 and 64 bit types, not int16'
    )
  })

  it('sends nothing and answers an error when no point is accepted', async () => {
    const context = applied()
    const client = await connectInMemory(context)

    const result = await client.callTool({
      name: 'client_apply_point_table',
      arguments: { points: [{ name: 'X', address: 2, dataType: 'int16' }] }
    })

    expect(result.isError).toBe(true)
    expect(context.send).not.toHaveBeenCalled()
    expect(jsonOf(result)).toMatchObject({
      applied: false,
      report: { points: [{ reason: 'A pdu0 address needs a registerType' }] }
    })
  })

  it('answers a refusal from the window as an error', async () => {
    const context = fakeContext({
      client_apply_point_table: async () => ({
        outcome: 'refused',
        registerConfig: defaultRegisterConfig,
        unitId: 0
      })
    })
    const client = await connectInMemory(context)

    const result = await client.callTool({
      name: 'client_apply_point_table',
      arguments: { points: TABLE, notation: 'modicon' }
    })

    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('Modbux refused a setting, so the configuration before it is kept.')
  })
})

describe('client_write', () => {
  const writable = () => {
    const context = fakeContext()
    context.setAllowWrites(true)
    context.setClientState({ connectState: 'connected' })
    return context
  }

  it('is refused while writes are off, and writes nothing', async () => {
    const context = writable()
    context.setAllowWrites(false)
    const client = await connectInMemory(context)

    const result = await client.callTool({
      name: 'client_write',
      arguments: { address: 0, registerType: 'holding_registers', words: [1] }
    })

    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe(WRITES_NOT_ALLOWED)
    expect(context.writeRaw).not.toHaveBeenCalled()
  })

  it('is refused while the client is not connected', async () => {
    const context = writable()
    context.setClientState({ connectState: 'disconnected' })
    const client = await connectInMemory(context)

    const result = await client.callTool({
      name: 'client_write',
      arguments: { address: 0, registerType: 'holding_registers', words: [1] }
    })

    expect(textOf(result)).toBe('The client is not connected. Call client_connect first.')
    expect(context.writeRaw).not.toHaveBeenCalled()
  })

  it('encodes an engineering value in the byte order asked for', async () => {
    const context = writable()
    const client = await connectInMemory(context)

    const result = await client.callTool({
      name: 'client_write',
      arguments: {
        address: 40011,
        notation: 'modicon',
        value: 230.5,
        dataType: 'float',
        scalingFactor: 0.1,
        byteOrder: 'CDAB'
      }
    })

    const words = createRegisters('float', 2305, byteOrderFlags('CDAB'))
    expect(context.writeRaw).toHaveBeenCalledWith({
      type: 'holding_registers',
      address: 10,
      words,
      single: false
    })
    expect(jsonOf(result)).toEqual({
      registerType: 'holding_registers',
      address: 10,
      unitId: 7,
      words,
      dataType: 'float',
      byteOrder: 'CDAB',
      raw: 2305
    })
  })

  it("takes the client's byte order when none is asked for", async () => {
    const context = writable()
    context.appState.registerConfig.littleEndian = true
    context.appState.registerConfig.byteSwap = true
    const client = await connectInMemory(context)

    await client.callTool({
      name: 'client_write',
      arguments: {
        address: 0,
        registerType: 'holding_registers',
        value: 0x12345678,
        dataType: 'uint32'
      }
    })

    expect(context.writeRaw.mock.calls[0]?.[0]).toMatchObject({ words: [0x7856, 0x3412] })
  })

  it('writes raw words as given, and one word with FC6 when single', async () => {
    const context = writable()
    const client = await connectInMemory(context)

    await client.callTool({
      name: 'client_write',
      arguments: { address: 1, registerType: 'holding_registers', words: [0xffff], single: true }
    })

    expect(context.writeRaw).toHaveBeenCalledWith({
      type: 'holding_registers',
      address: 1,
      words: [0xffff],
      single: true
    })
  })

  it('writes coils, by a modicon address', async () => {
    const context = writable()
    const client = await connectInMemory(context)

    const result = await client.callTool({
      name: 'client_write',
      arguments: { address: '00003', notation: 'modicon', coils: [true, false] }
    })

    expect(context.writeRaw).toHaveBeenCalledWith({
      type: 'coils',
      address: 2,
      values: [true, false],
      single: false
    })
    expect(jsonOf(result)).toMatchObject({ registerType: 'coils', coils: [true, false] })
  })

  it.each([
    [
      { address: 30001, notation: 'modicon', words: [1] },
      'input_registers are read only; write coils or holding_registers'
    ],
    [
      { address: 0, registerType: 'coils', words: [1] },
      'A coil write takes `coils`, a list of booleans'
    ],
    [
      { address: 0, registerType: 'coils', coils: [true], value: 1 },
      'A coil write takes `coils`, not `value` or `words`'
    ],
    [
      { address: 0, registerType: 'coils', coils: [true, true], single: true },
      'A single coil write carries one coil'
    ],
    [{ address: 65535, registerType: 'coils', coils: [true, true] }, '2 from 65535 run past 65535'],
    [
      { address: 0, registerType: 'holding_registers', coils: [true] },
      'A holding register write takes `value` or `words`, not `coils`'
    ],
    [
      { address: 0, registerType: 'holding_registers' },
      'A holding register write takes either `value` with `dataType`, or `words`'
    ],
    [
      { address: 0, registerType: 'holding_registers', value: 1, words: [1] },
      'A holding register write takes either `value` with `dataType`, or `words`'
    ],
    [{ address: 0, registerType: 'holding_registers', value: 1 }, 'A `value` needs a `dataType`'],
    [
      { address: 0, registerType: 'holding_registers', value: 1, dataType: 'real' },
      'Data type real is unknown'
    ],
    [
      { address: 0, registerType: 'holding_registers', value: 1, dataType: 'utf8' },
      "Modbux writes no utf8 value; write the string's words instead"
    ],
    [
      {
        address: 0,
        registerType: 'holding_registers',
        value: 1,
        dataType: 'int16',
        byteOrder: 'BADC'
      },
      'Byte order BADC swaps bytes, which applies to 32 and 64 bit types, not int16'
    ],
    [
      { address: 0, registerType: 'holding_registers', value: 70000, dataType: 'uint16' },
      'Raw value 70000: A uint16 value has to be between 0 and 65535'
    ],
    [
      { address: 0, registerType: 'holding_registers', value: 1, dataType: 'int32', single: true },
      'A single register write carries one word'
    ],
    [
      { address: 65535, registerType: 'holding_registers', value: 1, dataType: 'int32' },
      '2 from 65535 run past 65535'
    ],
    [{ address: 0, words: [1] }, 'A pdu0 address needs a registerType']
  ])('refuses %j', async (input, message) => {
    const context = writable()
    const client = await connectInMemory(context)

    const result = await client.callTool({ name: 'client_write', arguments: input })

    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe(message)
    expect(context.writeRaw).not.toHaveBeenCalled()
  })

  it.each([
    ['busy', 'The client is busy with another request. Try again once it has finished.'],
    ['refused', 'Modbux refused the write before it went out; the window says why.'],
    ['not_connected', 'The client is not connected. Call client_connect first.']
  ] as const)('answers a write that did not go out (%s) as an error', async (reason, message) => {
    const context = writable()
    context.writeRaw.mockResolvedValueOnce({ written: false, reason })
    const client = await connectInMemory(context)

    const result = await client.callTool({
      name: 'client_write',
      arguments: { address: 0, registerType: 'holding_registers', words: [1] }
    })

    expect(textOf(result)).toBe(message)
  })

  it("answers the device's exception as an error carrying it", async () => {
    const context = writable()
    context.writeRaw.mockResolvedValueOnce({ written: true, error: 'Illegal data address' })
    const client = await connectInMemory(context)

    const result = await client.callTool({
      name: 'client_write',
      arguments: { address: 0, registerType: 'holding_registers', words: [1] }
    })

    expect(result.isError).toBe(true)
    expect(jsonOf(result)).toMatchObject({ words: [1], error: 'Illegal data address' })
  })
})

describe('server_apply_point_table', () => {
  const TABLE = [
    {
      name: 'Voltage',
      address: 0,
      registerType: 'holding_registers',
      dataType: 'float',
      scalingFactor: 0.1,
      value: 230.5
    },
    {
      name: 'Energy',
      address: 2,
      registerType: 'holding_registers',
      dataType: 'int32',
      byteOrder: 'CDAB',
      value: -123456
    },
    { name: 'Run', address: 0, registerType: 'coils', value: true },
    { name: 'Bad', address: 4, registerType: 'holding_registers', dataType: 'uint16', value: -1 }
  ]

  it('names the servers when the input names none', async () => {
    const context = serverContext()
    const client = await connectInMemory(context)

    const result = await client.callTool({
      name: 'server_apply_point_table',
      arguments: { points: TABLE }
    })

    expect(textOf(result)).toBe(
      'Name the server by uuid or port. The servers are: main (port 502), sim (port 503, Meter)'
    )
  })

  it.each([
    [{ port: 504 }, 'No server has port 504.'],
    [{ uuid: 'gone' }, 'No server has uuid gone.'],
    [{ uuid: 'sim', port: 502 }, 'No server has uuid sim and port 502.']
  ])('refuses %j, which names no server', async (target, message) => {
    const context = serverContext()
    const client = await connectInMemory(context)

    const result = await client.callTool({
      name: 'server_apply_point_table',
      arguments: { ...target, points: TABLE }
    })

    expect(textOf(result)).toBe(
      `${message} The servers are: main (port 502), sim (port 503, Meter)`
    )
  })

  it('answers the report on a dry run and applies nothing', async () => {
    const context = serverContext()
    const client = await connectInMemory(context)

    const result = await client.callTool({
      name: 'server_apply_point_table',
      arguments: { port: 503, points: TABLE, dryRun: true }
    })

    expect(commandNames(context)).toEqual(['server_list'])
    expect(jsonOf(result)).toMatchObject({
      dryRun: true,
      server: { uuid: 'sim', port: '503' },
      report: { accepted: 3, rejected: 1 }
    })
  })

  it("sends the accepted points to the unit the server shows, in the table's byte order", async () => {
    const context = serverContext({
      server_apply_point_table: async () => ({ ...SIM_VALUES, byteOrder: 'CDAB' })
    })
    const client = await connectInMemory(context)

    const result = await client.callTool({
      name: 'server_apply_point_table',
      arguments: { port: 503, points: TABLE }
    })

    const payload = sentPayload(context, 'server_apply_point_table') as {
      uuid: string
      byteOrder: string
      units: Record<string, { holding_registers: Record<string, { params: unknown }> }>
    }
    expect(payload.uuid).toBe('sim')
    expect(payload.byteOrder).toBe('CDAB')
    expect(Object.keys(payload.units)).toEqual(['2'])
    expect(payload.units['2']?.holding_registers[0]?.params).toMatchObject({ value: 2305 })
    expect(payload.units['2']?.holding_registers[2]?.params).toMatchObject({ value: -123456 })
    expect(jsonOf(result)).toMatchObject({ applied: true, byteOrder: 'CDAB', unitIds: [2] })
  })

  it('sends to the unit the input names', async () => {
    const context = serverContext({ server_apply_point_table: async () => SIM_VALUES })
    const client = await connectInMemory(context)

    await client.callTool({
      name: 'server_apply_point_table',
      arguments: { uuid: 'sim', unitId: 9, points: TABLE }
    })

    const payload = sentPayload(context, 'server_apply_point_table') as { units: object }
    expect(Object.keys(payload.units)).toEqual(['9'])
  })

  it('answers a failure of the window as an error', async () => {
    const context = serverContext({
      server_apply_point_table: async () => {
        throw new Error('server_apply_point_table: The server view is in its own window')
      }
    })
    const client = await connectInMemory(context)

    const result = await client.callTool({
      name: 'server_apply_point_table',
      arguments: { uuid: 'sim', points: TABLE }
    })

    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('server_apply_point_table: The server view is in its own window')
  })
})

describe('server_get_values', () => {
  it("answers every register with its raw value and the words, in the server's byte order", async () => {
    const context = serverContext()
    context.setServerWords('sim', '2', 'holding_registers', 0, [
      ...createRegisters('float', 2305, byteOrderFlags('CDAB')),
      0xfffe,
      0xffff,
      0xffff,
      0xffff,
      7
    ])
    context.setServerWords('sim', '2', 'input_registers', 0, [0x4142, 0])
    const client = await connectInMemory(context)

    const result = await client.callTool({ name: 'server_get_values', arguments: { port: 503 } })

    expect(jsonOf(result)).toEqual({
      uuid: 'sim',
      port: '503',
      byteOrder: 'CDAB',
      units: [
        {
          unitId: 2,
          registers: [
            { registerType: 'coils', address: 4, value: true, comment: 'Run' },
            {
              registerType: 'holding_registers',
              address: 0,
              dataType: 'float',
              comment: 'Voltage',
              value: 2305,
              words: createRegisters('float', 2305, byteOrderFlags('CDAB'))
            },
            {
              registerType: 'holding_registers',
              address: 2,
              dataType: 'int64',
              comment: 'Energy',
              value: '-2',
              words: [0xfffe, 0xffff, 0xffff, 0xffff]
            },
            {
              registerType: 'holding_registers',
              address: 6,
              dataType: 'uint16',
              comment: 'Level',
              value: 7,
              words: [7],
              generator: { min: 0, max: 10, intervalMs: 1000 }
            },
            {
              registerType: 'input_registers',
              address: 0,
              dataType: 'utf8',
              comment: 'Serial',
              value: 'AB',
              words: [0x4142, 0]
            }
          ]
        },
        {
          unitId: 3,
          registers: [{ registerType: 'discrete_inputs', address: 0, value: false }]
        }
      ]
    })
  })

  // The store keeps a float rounded to three decimals, so re-encoding it
  // reported words the server does not answer a read with.
  it('answers the words the server holds, not an encoding of the stored value', async () => {
    const context = serverContext({
      server_get_values: async () => ({
        ...SIM_VALUES,
        units: {
          '2': {
            coils: {},
            discrete_inputs: {},
            input_registers: {},
            holding_registers: {
              0: {
                value: 1.235,
                params: {
                  address: 0,
                  registerType: 'holding_registers',
                  dataType: 'float',
                  comment: 'Voltage',
                  value: 1.23456
                }
              }
            }
          }
        }
      })
    })
    const wire = createRegisters('float', 1.23456, byteOrderFlags('CDAB'))
    context.setServerWords('sim', '2', 'holding_registers', 0, wire)
    const client = await connectInMemory(context)

    const result = await client.callTool({ name: 'server_get_values', arguments: { port: 503 } })

    const [unit] = jsonOf(result).units as { registers: { words?: number[] }[] }[]
    expect(unit?.registers[0]?.words).toEqual(wire)
    expect(context.server.readRegisters).toHaveBeenCalledWith('sim', '2', 'holding_registers', 0, 2)
  })

  it('narrows the answer to the unit asked for', async () => {
    const context = serverContext()
    const client = await connectInMemory(context)

    const result = await client.callTool({
      name: 'server_get_values',
      arguments: { uuid: 'sim', unitId: 3 }
    })

    expect((jsonOf(result).units as { unitId: number }[]).map((unit) => unit.unitId)).toEqual([3])
  })
})

describe('server_set_values', () => {
  it('converts each value by its register, and sends the accepted ones', async () => {
    const context = serverContext({
      server_set_values: async () => ({ results: ['set', 'set', 'set'] })
    })
    const client = await connectInMemory(context)

    const result = await client.callTool({
      name: 'server_set_values',
      arguments: {
        port: 503,
        values: [
          { address: 40001, notation: 'modicon', value: 231.5, scalingFactor: 0.1 },
          { address: 4, registerType: 'coils', value: false },
          { address: 0, registerType: 'input_registers', value: 'CD' },
          { address: 6, registerType: 'holding_registers', value: 3 },
          { address: 3, registerType: 'holding_registers', value: 3 },
          { address: 9, registerType: 'holding_registers', value: 3 },
          { address: 5, registerType: 'coils', value: true },
          { address: 4, registerType: 'coils', value: 1 },
          { address: 0, registerType: 'holding_registers', value: true },
          { address: 0, registerType: 'input_registers', value: 'ABCDE' },
          { address: 0, registerType: 'input_registers', value: 5 }
        ]
      }
    })

    expect(sentPayload(context, 'server_set_values')).toEqual({
      uuid: 'sim',
      values: [
        { unitId: '2', registerType: 'holding_registers', address: 0, value: 2315 },
        { unitId: '2', registerType: 'coils', address: 4, value: false },
        { unitId: '2', registerType: 'input_registers', address: 0, value: 'CD' }
      ]
    })
    const answer = jsonOf(result) as { values: { reason?: string }[] }
    expect(answer.values.map((value) => value.reason)).toEqual([
      undefined,
      undefined,
      undefined,
      'The register at 6 is driven by a generator; apply a point table to fix its value',
      'holding_registers 3 is inside the int64 at 2',
      'Unit 2 has no holding_registers register at 9; apply a point table to add one',
      'Unit 2 has no coils entry at 5; apply a point table to add one',
      'A coils value is true or false',
      'A float value is a number',
      '"ABCDE" is 5 bytes, and 2 registers hold 4',
      'A utf8 value is a string'
    ])
  })

  it("reports a value the window did not set as rejected, with the window's reason", async () => {
    const context = serverContext({
      server_set_values: async () => ({ results: ['generator'] })
    })
    const client = await connectInMemory(context)

    const result = await client.callTool({
      name: 'server_set_values',
      arguments: {
        uuid: 'sim',
        values: [
          { address: 0, registerType: 'holding_registers', value: 1 },
          { address: 4, registerType: 'coils', value: true }
        ]
      }
    })

    const answer = jsonOf(result) as { accepted: number; values: { reason?: string }[] }
    expect(answer.values.map((value) => value.reason)).toEqual([
      'A generator drives this register now',
      'Modbux did not answer for this value'
    ])
    expect(answer.accepted).toBe(0)
  })

  it('sends nothing on a dry run', async () => {
    const context = serverContext()
    const client = await connectInMemory(context)

    const result = await client.callTool({
      name: 'server_set_values',
      arguments: {
        uuid: 'sim',
        dryRun: true,
        values: [{ address: 0, registerType: 'holding_registers', value: 1 }]
      }
    })

    expect(commandNames(context)).toEqual(['server_list', 'server_get_values'])
    expect(jsonOf(result)).toMatchObject({ dryRun: true, accepted: 1 })
  })

  it('answers an error and sends nothing when no value is accepted', async () => {
    const context = serverContext()
    const client = await connectInMemory(context)

    const result = await client.callTool({
      name: 'server_set_values',
      arguments: { uuid: 'sim', values: [{ address: 9, registerType: 'coils', value: true }] }
    })

    expect(result.isError).toBe(true)
    expect(commandNames(context)).toEqual(['server_list', 'server_get_values'])
  })
})
