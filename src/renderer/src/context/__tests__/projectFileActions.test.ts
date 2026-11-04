// @vitest-environment happy-dom
//
// Save project and Open project without the file: one client and every server
// go out as text and come back in. The file is parsed whole before anything
// changes, and the servers are replaced rather than merged.
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
  // Main binds the port it is asked for, as it does when the port is free.
  answerWith('createServer', (payload) => Promise.resolve((payload as { port: number }).port))
  answerWith('setServerPort', (payload) => Promise.resolve((payload as { port: number }).port))
  calls = []
  recordApiCalls(calls)
})

type Modules = {
  client: () => ReturnType<typeof import('../client.zustand').useClientZustand.getState>
  server: () => ReturnType<typeof import('../server.zustand').useServerZustand.getState>
  undo: () => ReturnType<typeof import('../undo.zustand').useUndoZustand.getState>
  file: typeof import('../projectFile')
  setConnected: (connected: boolean) => void
}

const load = async (): Promise<Modules> => {
  const { useClientZustand } = await import('../client.zustand')
  const { useServerZustand } = await import('../server.zustand')
  const { useUndoZustand } = await import('../undo.zustand')
  const { useDataZustand } = await import('../data.zustand')
  const file = await import('../projectFile')
  useServerZustand.setState({
    selectedUuid: MAIN_SERVER_UUID,
    servers: { [MAIN_SERVER_UUID]: { ...getDefaultServer(), port: '502' } },
    ready: { [MAIN_SERVER_UUID]: true },
    serverMode: 'tcp'
  })
  return {
    client: () => useClientZustand.getState(),
    server: () => useServerZustand.getState(),
    undo: () => useUndoZustand.getState(),
    file,
    setConnected: (connected: boolean) =>
      useDataZustand.getState().setClientState({
        ...defaultClientState,
        connectState: connected ? 'connected' : 'disconnected'
      })
  }
}

const SECOND = 'second-server'

/** A client with a name and a mapping, a main server and a second one, each with data. */
const buildProject = async ({ client, server }: Modules): Promise<void> => {
  await client().setType('holding_registers')
  client().setName('boiler')
  client().setRegisterMapping(3, 'comment', 'pump')
  await client().setUnitId('17')
  await client().setHost('10.0.0.5', true)

  server().setName('first')
  server().addBool('coils', 3)
  await server().createServer({ uuid: SECOND, port: 1503 })
  server().setName('second')
  await server().setLittleEndian(true)
  server().addBool('discrete_inputs', 8)
}

/** Takes the client and the servers somewhere else, so an import has something to undo. */
const moveElsewhere = async ({ client, server }: Modules): Promise<void> => {
  client().setName('other')
  await client().clearRegisterMapping()
  await client().setUnitId('2')
  for (const uuid of Object.keys(server().servers)) {
    if (uuid !== MAIN_SERVER_UUID) await server().deleteServer(uuid)
  }
  await server().createServer({ uuid: 'stray', port: 1600 })
  server().setName('stray')
  server().setSelectedUuid(MAIN_SERVER_UUID)
  server().setName('')
}

describe('exportProject', () => {
  it('writes the main server first and the selection as an index', async () => {
    const modules = await load()
    await buildProject(modules)
    modules.server().setSelectedUuid(SECOND)

    const written = JSON.parse(modules.file.exportProject())

    expect(written.kind).toBe('project')
    expect(written.client.name).toBe('boiler')
    expect(written.servers.map((s: { name: string; port: number }) => [s.name, s.port])).toEqual([
      ['first', 502],
      ['second', 1503]
    ])
    expect(written.selectedServer).toBe(1)
    expect(written.serverMode).toBe('tcp')
  })
})

describe('importProject', () => {
  it('opens what it saved, replacing the servers', async () => {
    const modules = await loadAndBuild()
    const { client, server, file } = modules
    server().setSelectedUuid(SECOND)
    const saved = file.exportProject()
    await moveElsewhere(modules)

    expect(await file.importProject(saved)).toMatchObject({
      ok: true,
      migrated: false,
      portsRefused: [],
      serversRefused: 0
    })

    expect(client().name).toBe('boiler')
    expect(client().connectionConfig.unitId).toBe(17)
    expect(client().connectionConfig.tcp.host).toBe('10.0.0.5')
    expect(client().registerMapping.holding_registers[3]).toEqual({ comment: 'pump' })
    const uuids = Object.keys(server().servers)
    expect(uuids).toHaveLength(2)
    expect(uuids[0]).toBe(MAIN_SERVER_UUID)
    expect(uuids).not.toContain('stray')
    const [, secondUuid = ''] = uuids
    expect(server().servers[MAIN_SERVER_UUID]).toMatchObject({ name: 'first', port: '502' })
    expect(server().servers[MAIN_SERVER_UUID]?.registers['0']?.coils[3]).toEqual({ value: false })
    expect(server().servers[secondUuid]).toMatchObject({
      name: 'second',
      port: '1503',
      littleEndian: true
    })
    expect(server().servers[secondUuid]?.registers['0']?.discrete_inputs[8]).toEqual({
      value: false
    })
    expect(server().selectedUuid).toBe(secondUuid)
  })

  it('records one client step and one step per server, which undo takes back', async () => {
    const modules = await loadAndBuild()
    const { client, server, undo, file } = modules
    const saved = file.exportProject()
    await moveElsewhere(modules)
    const clientSteps = undo().client.past.length
    const serverSteps = undo().server.past.length

    await file.importProject(saved)

    // The deleted stray server, the main server, and the one created.
    expect(undo().client.past).toHaveLength(clientSteps + 1)
    expect(undo().server.past).toHaveLength(serverSteps + 3)

    const { undoClient } = await import('../clientUndo')
    const { undoServer } = await import('../serverUndo')
    expect(await undoClient()).toBe('done')
    expect(client().name).toBe('other')
    for (let step = 0; step < 3; step++) expect(await undoServer()).toBe('done')
    expect(Object.keys(server().servers).sort()).toEqual([MAIN_SERVER_UUID, 'stray'].sort())
  })

  it('applies the server mode and the serial settings', async () => {
    const modules = await loadAndBuild()
    const { server, file } = modules
    const written = JSON.parse(file.exportProject())
    written.serverMode = 'rtu'
    written.serialConfig = {
      com: '/dev/ttyUSB1',
      options: { baudRate: '19200', parity: 'even', dataBits: 7, stopBits: 2 }
    }

    expect(await file.importProject(JSON.stringify(written))).toMatchObject({ ok: true })

    expect(server().serverMode).toBe('rtu')
    expect(server().serialConfig).toEqual(written.serialConfig)
    expect(calls.map((call) => call.method)).toContain('startRtuServer')
  })

  it('leaves RTU for TCP when the file says tcp', async () => {
    const modules = await loadAndBuild()
    const { server, file } = modules
    const saved = file.exportProject()
    await server().switchToRtu()

    expect(await file.importProject(saved)).toMatchObject({ ok: true })

    expect(server().serverMode).toBe('tcp')
    expect(Object.keys(server().servers)).toHaveLength(2)
  })

  it('keeps loading when main refuses a port, and says which', async () => {
    const modules = await loadAndBuild()
    const { server, file } = modules
    const saved = file.exportProject()
    await modules.server().deleteServer(SECOND)
    answerWith('setServerPort', () => Promise.resolve(9999))
    answerWith('createServer', () => Promise.resolve(9998))

    const outcome = await file.importProject(saved)

    expect(outcome).toMatchObject({ ok: true, portsRefused: [1503] })
    expect(server().servers[MAIN_SERVER_UUID]?.name).toBe('first')
    expect(Object.keys(server().servers)).toHaveLength(2)
  })

  it('counts a server main will not create, and loads the rest', async () => {
    const modules = await loadAndBuild()
    const { server, file } = modules
    const saved = file.exportProject()
    await modules.server().deleteServer(SECOND)
    answerWith('createServer', () => Promise.resolve(undefined))

    expect(await file.importProject(saved)).toMatchObject({ ok: true, serversRefused: 1 })

    expect(Object.keys(server().servers)).toEqual([MAIN_SERVER_UUID])
    expect(server().servers[MAIN_SERVER_UUID]?.name).toBe('first')
  })

  it('changes nothing for a file that does not parse, or is the wrong kind', async () => {
    const modules = await loadAndBuild()
    const { client, server, undo, file } = modules
    const { exportClientConfig } = await import('../clientConfigFile')
    const clientFile = exportClientConfig()
    calls.length = 0
    const steps = [undo().client.past.length, undo().server.past.length]

    expect(await file.importProject('{ not json')).toMatchObject({ ok: false })
    expect(await file.importProject(clientFile)).toEqual({
      ok: false,
      error: expect.stringContaining('This is a client configuration, not a project file')
    })

    expect(client().name).toBe('boiler')
    expect(Object.keys(server().servers)).toHaveLength(2)
    expect(calls).toEqual([])
    expect([undo().client.past.length, undo().server.past.length]).toEqual(steps)
  })

  it('is refused whole while a connection stands and the file connects elsewhere', async () => {
    const modules = await loadAndBuild()
    const { client, server, undo, file, setConnected } = modules
    const saved = file.exportProject()
    await modules.client().setHost('192.168.1.10', true)
    await modules.server().deleteServer(SECOND)
    setConnected(true)
    calls.length = 0
    const steps = [undo().client.past.length, undo().server.past.length]

    expect(await file.importProject(saved)).toEqual({
      ok: false,
      error: 'The file holds other connection settings. Disconnect first, then open it again.'
    })

    expect(client().connectionConfig.tcp.host).toBe('192.168.1.10')
    expect(Object.keys(server().servers)).toEqual([MAIN_SERVER_UUID])
    expect(calls.map((call) => call.method)).not.toContain('resetServer')
    expect([undo().client.past.length, undo().server.past.length]).toEqual(steps)
  })
})

const loadAndBuild = async (): Promise<Modules> => {
  const modules = await load()
  await buildProject(modules)
  return modules
}
