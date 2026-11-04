// @vitest-environment happy-dom
//
// Save and Open without the file: what the store holds goes out as text, and
// text comes back in as one step to undo. A file that does not parse changes
// nothing and records nothing.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAIN_SERVER_UUID } from '@shared'
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

const loadClient = async (): Promise<{
  client: () => ReturnType<typeof import('../client.zustand').useClientZustand.getState>
  undo: () => ReturnType<typeof import('../undo.zustand').useUndoZustand.getState>
  clientUndo: typeof import('../clientUndo')
  file: typeof import('../clientConfigFile')
}> => {
  const { useClientZustand } = await import('../client.zustand')
  const { useUndoZustand } = await import('../undo.zustand')
  return {
    client: () => useClientZustand.getState(),
    undo: () => useUndoZustand.getState(),
    clientUndo: await import('../clientUndo'),
    file: await import('../clientConfigFile')
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
