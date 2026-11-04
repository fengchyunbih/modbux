/* eslint-disable @typescript-eslint/explicit-function-return-type */
// @vitest-environment happy-dom
//
// The point table commands from main through the main window's real stores and
// back, wired as `rendererCommandRoundTrip.test.ts` wires them: main's
// `windows.send` delivers to the listener `@renderer/commands` installs, and the
// renderer's reply goes to `RendererCommands.receive`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import {
  acceptedPoints,
  clientMappingOf,
  defaultClientState,
  MAIN_SERVER_UUID,
  readWindowOf,
  serverUnitsOf,
  validatePointTable
} from '@shared'
import { fireEvent, stubRenderer } from '@renderer/context/__tests__/stubRenderer'
import { getDefaultServer } from '@renderer/context/server.zustand.helpers'
import type { Windows } from '../main/windows'
import { RendererCommandError, RendererCommands } from '../main/modules/rendererCommands'

vi.mock('notistack', () => ({ enqueueSnackbar: vi.fn() }))

const MAIN = { id: 'main' } as unknown as WebContents

const wireUp = async (): Promise<RendererCommands> => {
  const windows = {
    main: { isDestroyed: () => false },
    send: (event: string, payload: unknown) => fireEvent(event, payload),
    isMain: (contents: unknown) => contents === MAIN
  } as unknown as Windows
  const commands = new RendererCommands({ windows, timeoutMs: 2000 })
  stubRenderer({
    onSend: (event, reply) => {
      if (event === 'renderer_command_result') commands.receive(MAIN, reply)
    }
  })
  await import('@renderer/commands')
  const { useClientZustand } = await import('@renderer/context/client.zustand')
  useClientZustand.getState().init()
  return commands
}

const stores = async () => {
  const { useClientZustand, flushRegisterMappingToMain } =
    await import('@renderer/context/client.zustand')
  const { useServerZustand } = await import('@renderer/context/server.zustand')
  const { useDataZustand } = await import('@renderer/context/data.zustand')
  const { undoClient } = await import('@renderer/context/clientUndo')
  const { undoServer } = await import('@renderer/context/serverUndo')
  return {
    client: () => useClientZustand.getState(),
    server: () => useServerZustand.getState(),
    setServers: useServerZustand.setState,
    flush: () => flushRegisterMappingToMain(useClientZustand.getState().registerMapping),
    setConnected: (connected: boolean) =>
      useDataZustand.getState().setClientState({
        ...defaultClientState,
        connectState: connected ? 'connected' : 'disconnected'
      }),
    undoClient,
    undoServer
  }
}

const rejection = async (promise: Promise<unknown>): Promise<RendererCommandError> => {
  try {
    await promise
  } catch (error) {
    if (error instanceof RendererCommandError) return error
    throw error
  }
  throw new Error('the command resolved')
}

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
})

// The mapping sends on a 150 ms debounce; flushed so it fires before happy-dom goes.
afterEach(async () => {
  const { flush } = await stores()
  await flush()
})

describe('client_set_connection', () => {
  it('writes the fields named, keeps the rest, and is one undo step', async () => {
    const commands = await wireUp()
    const { client, undoClient } = await stores()
    const before = client().connectionConfig

    const result = await commands.send('client_set_connection', {
      unitId: 4,
      tcp: { host: '10.0.0.5', options: { port: 1502 } }
    })

    expect(result.outcome).toBe('done')
    expect(client().connectionConfig).toEqual({
      ...before,
      unitId: 4,
      tcp: { host: '10.0.0.5', options: { port: 1502 } }
    })
    expect(result.connectionConfig).toEqual(client().connectionConfig)

    expect(await undoClient()).toBe('done')
    expect(client().connectionConfig).toEqual(before)
  })

  it('refuses a connection field while connected, and takes the unit id', async () => {
    const commands = await wireUp()
    const { client, setConnected } = await stores()
    const before = client().connectionConfig
    setConnected(true)

    const refused = await commands.send('client_set_connection', {
      unitId: 9,
      tcp: { host: '10.0.0.9' }
    })
    expect(refused.outcome).toBe('refused-connected')
    expect(client().connectionConfig).toEqual(before)

    const taken = await commands.send('client_set_connection', { unitId: 9 })
    expect(taken.outcome).toBe('done')
    expect(client().connectionConfig.unitId).toBe(9)
  })

  it('keeps the mapping and read configuration', async () => {
    const commands = await wireUp()
    const { client } = await stores()
    await client().replaceRegisterMapping({
      ...client().registerMapping,
      holding_registers: { 3: { dataType: 'int16' } }
    })
    client().setReadConfiguration(true)

    await commands.send('client_set_connection', { tcp: { options: { port: 1503 } } })

    expect(client().registerMapping.holding_registers[3]).toEqual({ dataType: 'int16' })
    expect(client().readConfiguration).toBe(true)
  })
})

describe('client_apply_point_table', () => {
  const table = validatePointTable(
    [
      { name: 'Voltage', address: 40011, dataType: 'float', scalingFactor: 0.1, byteOrder: 'CDAB' },
      { name: 'Energy', address: 40013, dataType: 'int32' },
      { name: 'Run', address: '00002' }
    ],
    { target: 'client', notation: 'modicon', unitId: 3 }
  )
  const points = acceptedPoints(table)
  const covered = readWindowOf(points)
  if (!covered) throw new Error('the table covers nothing')

  it('replaces the mapping and sets the window, byte order and unit id, as one undo step', async () => {
    const commands = await wireUp()
    const { client, undoClient } = await stores()
    await client().replaceRegisterMapping({
      ...client().registerMapping,
      input_registers: { 7: { dataType: 'uint16', comment: 'old' } }
    })
    const before = {
      mapping: client().registerMapping,
      registerConfig: client().registerConfig,
      unitId: client().connectionConfig.unitId,
      name: client().name
    }

    const result = await commands.send('client_apply_point_table', {
      registerMapping: clientMappingOf(points),
      window: covered.window,
      byteOrder: table.byteOrder,
      unitId: table.unitId
    })

    expect(result.outcome).toBe('done')
    expect(client().registerMapping).toEqual({
      coils: { 1: { comment: 'Run' } },
      discrete_inputs: {},
      input_registers: {},
      holding_registers: {
        10: { comment: 'Voltage', dataType: 'float', scalingFactor: 0.1 },
        12: { comment: 'Energy', dataType: 'int32' }
      }
    })
    expect(client().registerConfig).toMatchObject({
      type: 'holding_registers',
      address: 10,
      length: 4,
      littleEndian: true,
      byteSwap: false
    })
    expect(client().connectionConfig.unitId).toBe(3)
    expect(client().name).toBe(before.name)
    expect(result).toMatchObject({ unitId: 3, registerConfig: { address: 10, length: 4 } })

    expect(await undoClient()).toBe('done')
    expect(client().registerMapping).toEqual(before.mapping)
    expect(client().registerConfig).toEqual(before.registerConfig)
    expect(client().connectionConfig.unitId).toBe(before.unitId)
  })

  it('applies while connected, because the unit id is no connection field', async () => {
    const commands = await wireUp()
    const { client, setConnected } = await stores()
    setConnected(true)

    const result = await commands.send('client_apply_point_table', {
      registerMapping: clientMappingOf(points),
      window: covered.window,
      unitId: 3
    })

    expect(result.outcome).toBe('done')
    expect(client().connectionConfig.unitId).toBe(3)
  })
})

// Two commands sent at once each record their own step only when the second
// starts after the first has finished: run together, both snapshot the same
// configuration as their step.
describe('commands sent at once', () => {
  it('run one after the other, each its own undo step', async () => {
    const commands = await wireUp()
    const { client, undoClient } = await stores()
    const before = client().connectionConfig

    await Promise.all([
      commands.send('client_set_connection', { tcp: { host: '10.0.0.1' } }),
      commands.send('client_set_connection', { tcp: { options: { port: 1502 } } })
    ])
    expect(client().connectionConfig.tcp).toEqual({ host: '10.0.0.1', options: { port: 1502 } })

    expect(await undoClient()).toBe('done')
    expect(client().connectionConfig.tcp).toEqual({
      host: '10.0.0.1',
      options: { port: before.tcp.options.port }
    })
    expect(await undoClient()).toBe('done')
    expect(client().connectionConfig).toEqual(before)
  })
})

describe('the server commands', () => {
  const SIM = 'sim'

  const withServers = async () => {
    const s = await stores()
    s.setServers({
      selectedUuid: MAIN_SERVER_UUID,
      ready: { [MAIN_SERVER_UUID]: true, [SIM]: true },
      servers: {
        [MAIN_SERVER_UUID]: { ...getDefaultServer(), port: '502' },
        [SIM]: { ...getDefaultServer(), port: '503', unitId: '0' }
      }
    })
    return s
  }

  const table = validatePointTable(
    [
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
      {
        name: 'Level',
        address: 4,
        registerType: 'input_registers',
        dataType: 'uint16',
        generator: { min: 0, max: 10 }
      },
      { name: 'Run', address: 1, registerType: 'coils', value: true }
    ],
    { target: 'server', unitId: 2 }
  )
  const units = serverUnitsOf(acceptedPoints(table))

  it('server_apply_point_table replaces the unit, sets the byte order and the bits, as one undo step', async () => {
    const commands = await wireUp()
    const { server, undoServer } = await withServers()

    const values = await commands.send('server_apply_point_table', {
      uuid: SIM,
      units,
      byteOrder: table.byteOrder
    })

    const sim = server().servers[SIM]
    expect(server().selectedUuid).toBe(SIM)
    expect(sim?.unitId).toBe('2')
    expect([sim?.littleEndian, sim?.byteSwap]).toEqual([true, false])
    expect(sim?.registers['2']?.holding_registers[0]?.params).toMatchObject({
      dataType: 'float',
      value: 2305,
      comment: 'Voltage'
    })
    expect(sim?.registers['2']?.input_registers[4]?.params).toMatchObject({
      min: 0,
      max: 10,
      interval: 1000
    })
    expect(sim?.registers['2']?.coils[1]).toEqual({ value: true, comment: 'Run' })
    expect(sim?.usedAddresses['2']?.holding_registers).toEqual([0, 1, 2, 3])
    expect(values).toMatchObject({ uuid: SIM, port: '503', byteOrder: 'CDAB' })

    expect(await undoServer()).toBe('done')
    const undone = server().servers[SIM]
    expect(undone?.registers['2']).toBeUndefined()
    expect([undone?.littleEndian, undone?.byteSwap]).toEqual([false, false])
  })

  it('records a step for a table that only sets a bit', async () => {
    const commands = await wireUp()
    const { server, undoServer } = await withServers()
    const coilOnly = {
      '2': {
        coils: { 1: { value: false } },
        discrete_inputs: {},
        input_registers: {},
        holding_registers: {}
      }
    }
    await commands.send('server_apply_point_table', { uuid: SIM, units: coilOnly })

    await commands.send('server_apply_point_table', {
      uuid: SIM,
      units: { '2': { ...coilOnly['2'], coils: { 1: { value: true } } } }
    })
    expect(server().servers[SIM]?.registers['2']?.coils[1]?.value).toBe(true)

    expect(await undoServer()).toBe('done')
    expect(server().servers[SIM]?.registers['2']?.coils[1]?.value).toBe(false)
  })

  it('server_get_values answers the store, and refuses a uuid it does not hold', async () => {
    const commands = await wireUp()
    await withServers()
    await commands.send('server_apply_point_table', { uuid: SIM, units })

    const values = await commands.send('server_get_values', { uuid: SIM })
    expect(values.units['2']?.coils[1]?.value).toBe(true)

    const error = await rejection(commands.send('server_get_values', { uuid: 'gone' }))
    expect(error.message).toBe('server_get_values: No server has uuid gone')
  })

  it('server_set_values writes a fixed register and a bit, and leaves a generator', async () => {
    const commands = await wireUp()
    const { server, undoServer } = await withServers()
    await commands.send('server_apply_point_table', { uuid: SIM, units })

    const { results } = await commands.send('server_set_values', {
      uuid: SIM,
      values: [
        { unitId: '2', registerType: 'holding_registers', address: 0, value: 2315 },
        { unitId: '2', registerType: 'coils', address: 1, value: false },
        { unitId: '2', registerType: 'input_registers', address: 4, value: 3 },
        { unitId: '2', registerType: 'holding_registers', address: 9, value: 3 },
        { unitId: '2', registerType: 'coils', address: 9, value: true }
      ]
    })

    expect(results).toEqual(['set', 'set', 'generator', 'no_register', 'no_register'])
    const unit = server().servers[SIM]?.registers['2']
    expect(unit?.holding_registers[0]?.params.value).toBe(2315)
    expect(unit?.coils[1]?.value).toBe(false)

    expect(await undoServer()).toBe('done')
    const undone = server().servers[SIM]?.registers['2']
    expect(undone?.holding_registers[0]?.params.value).toBe(2305)
    expect(undone?.coils[1]?.value).toBe(true)
  })

  it('refuses each server command while the server view is split out', async () => {
    const commands = await wireUp()
    await withServers()
    fireEvent('window_update', { main: true, server: true })

    for (const send of [
      () => commands.send('server_get_values', { uuid: SIM }),
      () => commands.send('server_apply_point_table', { uuid: SIM, units }),
      () => commands.send('server_set_values', { uuid: SIM, values: [] })
    ]) {
      const error = await rejection(send())
      expect(error.message).toMatch(
        /The server view is in its own window; close it to use server commands$/
      )
    }
  })

  it('refuses a server main has not opened', async () => {
    const commands = await wireUp()
    const { setServers } = await withServers()
    setServers((state) => {
      state.ready[SIM] = false
    })

    const error = await rejection(commands.send('server_apply_point_table', { uuid: SIM, units }))
    expect(error.message).toBe(
      `server_apply_point_table: Server ${SIM} is not open in main yet; try again`
    )
  })
})
