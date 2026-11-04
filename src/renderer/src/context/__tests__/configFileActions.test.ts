// @vitest-environment happy-dom
//
// Save and Open without the file: what the store holds goes out as text, and
// text comes back in as one step to undo. A file that does not parse changes
// nothing and records nothing.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultClientState, MAIN_SERVER_UUID } from '@shared'
import { recordApiCalls, stubRenderer, type ApiCall } from './stubRenderer'
import { getDefaultServer } from '../server.zustand.helpers'

vi.mock('notistack', () => ({ enqueueSnackbar: vi.fn() }))

let calls: ApiCall[]

/** Answers one channel differently from the stub, and leaves the rest to it. */
const answerWith = (method: string, answer: (payload: unknown) => Promise<unknown>): void => {
  const underneath = window.api as unknown as Record<string, unknown>
  window.api = new Proxy(
    {},
    { get: (_target, name: string): unknown => (name === method ? answer : underneath[name]) }
  ) as never
}

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  stubRenderer()
  answerWith('createServer', (payload) => Promise.resolve((payload as { port: number }).port))
  answerWith('setServerPort', (payload) => Promise.resolve((payload as { port: number }).port))
  calls = []
  recordApiCalls(calls)
})

/** Main answers `undefined` on one channel from here on, as it does for a payload it refuses. */
const refuse = (method: string): void => answerWith(method, () => Promise.resolve(undefined))

const loadClient = async (): Promise<{
  client: () => ReturnType<typeof import('../client.zustand').useClientZustand.getState>
  undo: () => ReturnType<typeof import('../undo.zustand').useUndoZustand.getState>
  clientUndo: typeof import('../clientUndo')
  file: typeof import('../clientConfigFile')
  setConnected: (connected: boolean) => void
}> => {
  const { useClientZustand } = await import('../client.zustand')
  const { useUndoZustand } = await import('../undo.zustand')
  const { useDataZustand } = await import('../data.zustand')
  return {
    client: () => useClientZustand.getState(),
    undo: () => useUndoZustand.getState(),
    clientUndo: await import('../clientUndo'),
    file: await import('../clientConfigFile'),
    setConnected: (connected) =>
      useDataZustand.getState().setClientState({
        ...defaultClientState,
        connectState: connected ? 'connected' : 'disconnected'
      })
  }
}

const loadServer = async (): Promise<{
  server: () => ReturnType<typeof import('../server.zustand').useServerZustand.getState>
  undo: () => ReturnType<typeof import('../undo.zustand').useUndoZustand.getState>
  serverUndo: typeof import('../serverUndo')
  file: typeof import('../serverConfigFile')
}> => {
  const { useServerZustand } = await import('../server.zustand')
  const { useUndoZustand } = await import('../undo.zustand')
  const serverUndo = await import('../serverUndo')
  useServerZustand.setState({
    selectedUuid: MAIN_SERVER_UUID,
    servers: { [MAIN_SERVER_UUID]: { ...getDefaultServer(), port: '502' } },
    ready: { [MAIN_SERVER_UUID]: true }
  })
  useUndoZustand.setState({ server: { past: [], future: [], openKey: undefined } })
  return {
    server: () => useServerZustand.getState(),
    undo: () => useUndoZustand.getState(),
    serverUndo,
    file: await import('../serverConfigFile')
  }
}

describe('the client', () => {
  it('opens what it saved, as one step that undo takes back', async () => {
    const { client, undo, clientUndo, file } = await loadClient()
    await client().setType('holding_registers')
    client().setName('boiler')
    client().setRegisterMapping(3, 'comment', 'pump')
    await client().setLittleEndian(true)
    const saved = file.exportClientConfig()

    client().setName('other')
    await client().setLittleEndian(false)
    await client().clearRegisterMapping()
    const steps = undo().client.past.length

    expect(await file.importClientConfig(saved)).toMatchObject({ ok: true, migrated: false })
    expect(client().name).toBe('boiler')
    expect(client().registerConfig.littleEndian).toBe(true)
    expect(client().registerMapping.holding_registers[3]).toEqual({ comment: 'pump' })
    expect(undo().client.past).toHaveLength(steps + 1)

    expect(await clientUndo.undoClient()).toBe('done')
    expect(client().name).toBe('other')
    expect(client().registerConfig.littleEndian).toBe(false)
    expect(client().registerMapping.holding_registers[3]).toBeUndefined()
  })

  it('changes nothing and records nothing for a file that does not parse', async () => {
    const { client, undo, file } = await loadClient()
    await client().setType('holding_registers')
    client().setName('boiler')
    client().setRegisterMapping(3, 'comment', 'pump')
    const steps = undo().client.past.length

    expect(await file.importClientConfig('{ not json')).toEqual({
      ok: false,
      error: expect.stringMatching(/JSON/)
    })
    expect(client().name).toBe('boiler')
    expect(client().registerMapping.holding_registers[3]).toEqual({ comment: 'pump' })
    expect(undo().client.past).toHaveLength(steps)
  })
})

describe('the server', () => {
  it('opens what it saved, as one step that undo takes back', async () => {
    const { server, undo, serverUndo, file } = await loadServer()
    server().setName('meter')
    server().addBool('coils', 3)
    const saved = file.exportServerConfig()
    if (saved === undefined) throw new Error('the selected server was not exported')

    await server().resetServer(MAIN_SERVER_UUID)
    server().setName('')
    undo().setServer({ past: [], future: [], openKey: undefined })

    expect(await file.importServerConfig(saved)).toMatchObject({ ok: true, migrated: false })
    expect(server().servers[MAIN_SERVER_UUID]?.name).toBe('meter')
    expect(server().servers[MAIN_SERVER_UUID]?.registers['0']?.coils[3]).toEqual({ value: false })
    expect(undo().server.past).toHaveLength(1)

    expect(await serverUndo.undoServer()).toBe('done')
    expect(server().servers[MAIN_SERVER_UUID]?.name).toBe('')
    expect(server().servers[MAIN_SERVER_UUID]?.registers['0']?.coils[3]).toBeUndefined()
  })

  it('changes nothing, in the store or in main, for a client config file', async () => {
    const { server, undo, file } = await loadServer()
    server().setName('meter')
    server().addBool('coils', 3)
    const clientFile = (await loadClient()).file.exportClientConfig()
    calls.length = 0

    expect(await file.importServerConfig(clientFile)).toEqual({
      ok: false,
      error: 'This is not a server configuration. A client configuration opens in the client.'
    })
    expect(server().servers[MAIN_SERVER_UUID]?.registers['0']?.coils[3]).toEqual({ value: false })
    expect(calls.map((call) => call.method)).not.toContain('resetServer')
    expect(undo().server.past).toHaveLength(2)
  })

  it('answers nothing to save for a selection that names no server', async () => {
    const { server, file } = await loadServer()
    server().setSelectedUuid('gone')

    expect(file.exportServerConfig()).toBeUndefined()
  })
})

type ClientModules = Awaited<ReturnType<typeof loadClient>>

/** A client with a mapping and every setting off its default, saved, then moved elsewhere. */
const savedClientThenMoved = async ({ client, file }: ClientModules): Promise<string> => {
  await client().setType('holding_registers')
  client().setName('boiler')
  client().setRegisterMapping(3, 'comment', 'pump')
  await client().setProtocol('ModbusRtu')
  await client().setHost('10.0.0.5', true)
  await client().setPort('1502')
  await client().setCom('/dev/ttyUSB1', true)
  await client().setBaudRate('19200')
  await client().setParity('even')
  await client().setUnitId('17')
  await client().setAddress('40')
  await client().setLength('20', true)
  await client().setPollRate(3000)
  await client().setAddressBase('1')
  await client().setLittleEndian(true)
  const saved = file.exportClientConfig()

  await client().setProtocol('ModbusTcp')
  await client().setHost('192.168.1.10', true)
  await client().setPort('502')
  await client().setCom('COM3', true)
  await client().setBaudRate('9600')
  await client().setParity('none')
  await client().setUnitId('1')
  await client().setAddress('0')
  await client().setLength('10', true)
  await client().setPollRate(1000)
  await client().setAddressBase('0')
  await client().setLittleEndian(false)
  await client().clearRegisterMapping()
  client().setName('other')
  return saved
}

const expectSavedSettings = (state: ClientModules['client']): void => {
  expect(state().connectionConfig).toEqual({
    protocol: 'ModbusRtu',
    unitId: 17,
    tcp: { host: '10.0.0.5', options: { port: 1502 } },
    rtu: {
      com: '/dev/ttyUSB1',
      options: expect.objectContaining({ baudRate: '19200', parity: 'even' })
    }
  })
  expect(state().registerConfig).toMatchObject({
    address: 40,
    length: 20,
    pollRate: 3000,
    addressBase: '1',
    littleEndian: true
  })
}

describe('a client config file with connection and read settings', () => {
  it('applies them, as the same one step that undo takes back', async () => {
    const modules = await loadClient()
    const { client, undo, clientUndo, file } = modules
    const saved = await savedClientThenMoved(modules)
    const steps = undo().client.past.length

    expect(await file.importClientConfig(saved)).toMatchObject({ ok: true })
    expectSavedSettings(client)
    expect(client().registerMapping.holding_registers[3]).toEqual({ comment: 'pump' })
    expect(undo().client.past).toHaveLength(steps + 1)

    expect(await clientUndo.undoClient()).toBe('done')
    expect(client().connectionConfig.protocol).toBe('ModbusTcp')
    expect(client().connectionConfig.tcp.host).toBe('192.168.1.10')
    expect(client().connectionConfig.unitId).toBe(1)
    expect(client().registerConfig.address).toBe(0)
    expect(client().registerConfig.littleEndian).toBe(false)

    expect(await clientUndo.redoClient()).toBe('done')
    expectSavedSettings(client)
  })

  it('is refused whole while a connection stands, and records nothing', async () => {
    const modules = await loadClient()
    const { client, undo, file, setConnected } = modules
    const saved = await savedClientThenMoved(modules)
    const steps = undo().client.past.length
    setConnected(true)

    expect(await file.importClientConfig(saved)).toEqual({
      ok: false,
      error: 'The file holds other connection settings. Disconnect first, then open it again.'
    })
    expect(client().connectionConfig.protocol).toBe('ModbusTcp')
    expect(client().registerConfig.address).toBe(0)
    expect(client().registerMapping.holding_registers[3]).toBeUndefined()
    expect(undo().client.past).toHaveLength(steps)
  })

  it('opens while a connection stands when the connection settings are the ones held', async () => {
    const { client, file, setConnected } = await loadClient()
    await client().setType('holding_registers')
    client().setRegisterMapping(3, 'comment', 'pump')
    await client().setAddress('40')
    const saved = file.exportClientConfig()
    await client().clearRegisterMapping()
    await client().setAddress('0')
    setConnected(true)

    expect(await file.importClientConfig(saved)).toMatchObject({ ok: true })
    expect(client().registerConfig.address).toBe(40)
    expect(client().registerMapping.holding_registers[3]).toEqual({ comment: 'pump' })
  })

  it('puts the settings back when main refuses the mapping', async () => {
    const modules = await loadClient()
    const { client, undo, file } = modules
    const saved = await savedClientThenMoved(modules)
    const steps = undo().client.past.length
    refuse('setRegisterMapping')

    expect(await file.importClientConfig(saved)).toEqual({
      ok: false,
      error: 'Main refused the configuration, so the one before it is kept.'
    })
    expect(client().connectionConfig.protocol).toBe('ModbusTcp')
    expect(client().connectionConfig.unitId).toBe(1)
    expect(client().registerConfig.address).toBe(0)
    expect(client().registerConfig.littleEndian).toBe(false)
    expect(undo().client.past).toHaveLength(steps)
  })
})

describe('a client config file from v2', () => {
  it('keeps the connection and read settings the client holds', async () => {
    const { client, file } = await loadClient()
    await client().setHost('10.0.0.5', true)
    await client().setUnitId('17')
    await client().setAddress('40')
    const v2 = JSON.stringify({
      version: 2,
      modbuxVersion: '2.2.0',
      name: 'old',
      littleEndian: true,
      registerMapping: {
        coils: {},
        discrete_inputs: {},
        input_registers: {},
        holding_registers: { '3': { comment: 'pump' } }
      }
    })

    expect(await file.importClientConfig(v2)).toMatchObject({ ok: true, migrated: true })
    expect(client().connectionConfig.tcp.host).toBe('10.0.0.5')
    expect(client().connectionConfig.unitId).toBe(17)
    expect(client().registerConfig.address).toBe(40)
    expect(client().registerConfig.littleEndian).toBe(true)
    expect(client().registerMapping.holding_registers[3]).toEqual({ comment: 'pump' })
  })
})

describe('a server config file with a port', () => {
  it('moves the server to it, as the same one step that undo takes back', async () => {
    const { server, undo, serverUndo, file } = await loadServer()
    await server().setPort('1502')
    server().addBool('coils', 3)
    const saved = file.exportServerConfig()
    if (saved === undefined) throw new Error('the selected server was not exported')
    await server().setPort('502')
    await server().resetServer(MAIN_SERVER_UUID)
    undo().setServer({ past: [], future: [], openKey: undefined })

    expect(await file.importServerConfig(saved)).toMatchObject({
      ok: true,
      portRefused: undefined
    })
    expect(server().servers[MAIN_SERVER_UUID]?.port).toBe('1502')
    expect(undo().server.past).toHaveLength(1)

    expect(await serverUndo.undoServer()).toBe('done')
    expect(server().servers[MAIN_SERVER_UUID]?.port).toBe('502')
    expect(server().servers[MAIN_SERVER_UUID]?.registers['0']?.coils[3]).toBeUndefined()

    expect(await serverUndo.redoServer()).toBe('done')
    expect(server().servers[MAIN_SERVER_UUID]?.port).toBe('1502')
  })

  it('names a port another server holds, and opens the rest', async () => {
    const { server, file } = await loadServer()
    server().setName('meter')
    server().addBool('coils', 3)
    const saved = JSON.parse(file.exportServerConfig() ?? '{}')
    saved.port = 503
    await server().resetServer(MAIN_SERVER_UUID)
    server().setName('')
    await useOtherServerOn('503')

    expect(await file.importServerConfig(JSON.stringify(saved))).toMatchObject({
      ok: true,
      portRefused: 503
    })
    expect(server().servers[MAIN_SERVER_UUID]?.port).toBe('502')
    expect(server().servers[MAIN_SERVER_UUID]?.name).toBe('meter')
    expect(server().servers[MAIN_SERVER_UUID]?.registers['0']?.coils[3]).toEqual({ value: false })
  })

  it('keeps the port the server has for a file from v3', async () => {
    const { server, file } = await loadServer()
    server().addBool('coils', 3)
    const saved = JSON.parse(file.exportServerConfig() ?? '{}')
    saved.version = 3
    delete saved.port
    delete saved.byteSwap
    await server().setPort('1502')

    expect(await file.importServerConfig(JSON.stringify(saved))).toMatchObject({
      ok: true,
      migrated: true
    })
    expect(server().servers[MAIN_SERVER_UUID]?.port).toBe('1502')
    expect(calls.filter((call) => call.method === 'setServerPort')).toHaveLength(1)
  })
})

/** A second server on `port`, which `setPort` refuses to share. */
const useOtherServerOn = async (port: string): Promise<void> => {
  const { useServerZustand } = await import('../server.zustand')
  const { servers } = useServerZustand.getState()
  useServerZustand.setState({ servers: { ...servers, other: { ...getDefaultServer(), port } } })
}
