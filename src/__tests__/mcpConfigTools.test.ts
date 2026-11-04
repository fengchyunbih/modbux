/* eslint-disable @typescript-eslint/explicit-function-return-type */
// @vitest-environment happy-dom
//
// The config file, server and project tools as an MCP client calls them: the
// SDK client talks to the real `createMcpServer` over its in-memory transport,
// main's `RendererCommands` hands each command to the listener
// `@renderer/commands` installs, and the stores answer. The two IPC hops and
// the Modbus ports are the only stand-ins.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import Ajv from 'ajv'
import type { WebContents } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAIN_SERVER_UUID } from '@shared'
import { fireEvent, recordApiCalls, stubRenderer } from '@renderer/context/__tests__/stubRenderer'
import type { ApiCall } from '@renderer/context/__tests__/stubRenderer'
import { getDefaultServer } from '@renderer/context/server.zustand.helpers'
import type { Windows } from '../main/windows'
import { RendererCommands } from '../main/modules/rendererCommands'
import { createMcpServer } from '../main/modules/mcp/server'
import {
  CLIENT_CONFIG_SCHEMA,
  PROJECT_SCHEMA,
  SERVER_CONFIG_SCHEMA
} from '../main/modules/mcp/jsonSchemas'
import type { McpToolContext } from '../main/modules/mcp/registry'

vi.mock('notistack', () => ({ enqueueSnackbar: vi.fn() }))

const MAIN = { id: 'main' } as unknown as WebContents

let calls: ApiCall[]
/** Ports main refuses to hand out as asked, which it walks past instead. */
let walkedPorts: Record<number, number>

const answerWith = (method: string, answer: (payload: unknown) => Promise<unknown>): void => {
  const underneath = window.api as unknown as Record<string, unknown>
  window.api = new Proxy(
    {},
    { get: (_target, name: string): unknown => (name === method ? answer : underneath[name]) }
  ) as never
}

const connect = async (): Promise<Client> => {
  const windows = {
    main: { isDestroyed: () => false },
    send: (event: string, payload: unknown) => fireEvent(event, payload),
    isMain: (contents: unknown) => contents === MAIN
  } as unknown as Windows
  const commands = new RendererCommands({ windows, timeoutMs: 1000 })
  stubRenderer({
    onSend: (event, reply) => {
      if (event === 'renderer_command_result') commands.receive(MAIN, reply)
    }
  })
  // Main binds the port it is asked for, or the one `walkedPorts` names.
  answerWith('createServer', (payload) => {
    const { port } = payload as { port: number }
    return Promise.resolve(walkedPorts[port] ?? port)
  })
  answerWith('setServerPort', (payload) => Promise.resolve((payload as { port: number }).port))
  calls = []
  recordApiCalls(calls)
  await import('@renderer/commands')

  const context = {
    rendererCommands: commands,
    mainWindowOpen: () => true,
    allowWrites: () => false
  } as unknown as McpToolContext
  const server = createMcpServer(context, '0.0.0-test')
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

const textOf = (result: unknown): string => {
  const content = (result as CallToolResult).content[0]
  if (content?.type !== 'text') throw new Error('the result has no text content')
  return content.text
}

const call = async (
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ isError: boolean; text: string }> => {
  const result = await client.callTool({ name, arguments: args })
  return { isError: result.isError === true, text: textOf(result) }
}

const ok = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const result = await call(client, name, args)
  expect(result.isError, result.text).toBe(false)
  return result.text
}

const stores = async () => {
  const { useClientZustand } = await import('@renderer/context/client.zustand')
  const { useServerZustand } = await import('@renderer/context/server.zustand')
  const { useUndoZustand } = await import('@renderer/context/undo.zustand')
  useServerZustand.setState({
    selectedUuid: MAIN_SERVER_UUID,
    servers: { [MAIN_SERVER_UUID]: { ...getDefaultServer(), port: '502' } },
    ready: { [MAIN_SERVER_UUID]: true },
    serverMode: 'tcp'
  })
  return { client: useClientZustand, server: useServerZustand, undo: useUndoZustand }
}

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  walkedPorts = {}
})

describe('client_export_config and client_import_config', () => {
  it('exports the file the Save button writes and imports it back', async () => {
    const mcp = await connect()
    const { client } = await stores()
    client.getState().setName('boiler')
    client.getState().setRegisterMapping(3, 'comment', 'pump')

    const json = await ok(mcp, 'client_export_config')
    expect(JSON.parse(json)).toMatchObject({ name: 'boiler', version: 3 })

    client.getState().setName('changed')
    client.getState().setRegisterMapping(3, 'comment', 'other')
    const answer = JSON.parse(await ok(mcp, 'client_import_config', { json }))

    expect(answer).toEqual({ imported: true, notes: [] })
    expect(client.getState().name).toBe('boiler')
    expect(client.getState().registerMapping.holding_registers[3]?.comment).toBe('pump')
  })

  it('reports a migration', async () => {
    const mcp = await connect()
    const { client } = await stores()
    const v2 = JSON.stringify({
      version: 2,
      modbuxVersion: '1.0.0',
      name: 'old',
      littleEndian: false,
      registerMapping: client.getState().registerMapping
    })

    const answer = JSON.parse(await ok(mcp, 'client_import_config', { json: v2 }))

    expect(answer.notes).toEqual(['The file was version 2 and was migrated.'])
  })

  it('answers a file that does not validate as an error and changes nothing', async () => {
    const mcp = await connect()
    const { client } = await stores()
    client.getState().setName('keep')

    const result = await call(mcp, 'client_import_config', { json: '{"version": "x"}' })

    expect(result.isError).toBe(true)
    expect(result.text.length).toBeGreaterThan(0)
    expect(client.getState().name).toBe('keep')
  })
})

describe('server_create, server_list and server_delete', () => {
  it('creates a named server on the port asked for, as one undo step', async () => {
    const mcp = await connect()
    const { undo } = await stores()

    const created = JSON.parse(await ok(mcp, 'server_create', { name: 'sim', port: 5020 }))
    const list = JSON.parse(await ok(mcp, 'server_list'))

    expect(created).toMatchObject({ name: 'sim', port: '5020' })
    expect(list.selectedUuid).toBe(created.uuid)
    expect(list.servers).toEqual([
      expect.objectContaining({ uuid: MAIN_SERVER_UUID, main: true, port: '502' }),
      expect.objectContaining({ uuid: created.uuid, main: false, name: 'sim', port: '5020' })
    ])
    expect(undo.getState().server.past).toHaveLength(1)
  })

  it('takes the first free port when none is asked for', async () => {
    const mcp = await connect()
    await stores()

    const created = JSON.parse(await ok(mcp, 'server_create'))

    expect(created.port).toBe('503')
  })

  it.each([
    ['15502', 15502, 'Port 15502 is reserved for the MCP server'],
    ['a port another server holds', 502, 'Port 502 is already used by another server']
  ])('refuses %s without asking main', async (_label, port, message) => {
    const mcp = await connect()
    await stores()

    calls.length = 0

    const result = await call(mcp, 'server_create', { port })

    expect(result).toEqual({ isError: true, text: message })
    expect(calls.map((entry) => entry.method)).not.toContain('createServer')
  })

  it('refuses a port main walked past, and leaves no server and no undo step', async () => {
    const mcp = await connect()
    const { server, undo } = await stores()
    walkedPorts[5020] = 5021

    const result = await call(mcp, 'server_create', { port: 5020 })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('Port 5020')
    expect(Object.keys(server.getState().servers)).toEqual([MAIN_SERVER_UUID])
    expect(undo.getState().server.past).toHaveLength(0)
  })

  it('refuses an eleventh server', async () => {
    const mcp = await connect()
    const { server } = await stores()
    for (let i = 1; i < 10; i++) {
      server.setState((state) => {
        state.servers[`s${i}`] = { ...getDefaultServer(), port: String(600 + i) }
      })
    }

    const result = await call(mcp, 'server_create')

    expect(result).toEqual({ isError: true, text: 'Modbux holds at most 10 servers' })
  })

  it('deletes a server, and refuses the main server and an unknown uuid', async () => {
    const mcp = await connect()
    const { server } = await stores()
    const { uuid } = JSON.parse(await ok(mcp, 'server_create'))

    expect(await call(mcp, 'server_delete', { uuid: MAIN_SERVER_UUID })).toEqual({
      isError: true,
      text: 'The main server cannot be deleted'
    })
    expect((await call(mcp, 'server_delete', { uuid: 'nope' })).isError).toBe(true)

    expect(JSON.parse(await ok(mcp, 'server_delete', { uuid }))).toEqual({ deleted: uuid })
    expect(Object.keys(server.getState().servers)).toEqual([MAIN_SERVER_UUID])
  })

  it('refuses every server tool while the server view is split out', async () => {
    const mcp = await connect()
    await stores()
    fireEvent('window_update', { main: true, server: true })

    for (const [name, args] of [
      ['server_list', {}],
      ['server_create', {}],
      ['server_delete', { uuid: 'x' }],
      ['server_export_config', { uuid: MAIN_SERVER_UUID }],
      ['server_import_config', { uuid: MAIN_SERVER_UUID, json: '{}' }],
      ['project_export', {}],
      ['project_import', { json: '{}' }]
    ] as const) {
      const result = await call(mcp, name, args)
      expect(result.isError, name).toBe(true)
      expect(result.text, name).toContain('The server view is in its own window')
    }
  })
})

describe('server_export_config and server_import_config', () => {
  it('exports one server by uuid without selecting it', async () => {
    const mcp = await connect()
    const { server } = await stores()
    const { uuid } = JSON.parse(await ok(mcp, 'server_create', { name: 'second', port: 5020 }))
    server.getState().setSelectedUuid(MAIN_SERVER_UUID)

    const file = JSON.parse(await ok(mcp, 'server_export_config', { uuid }))

    expect(file).toMatchObject({ name: 'second', port: 5020, version: 4 })
    expect(server.getState().selectedUuid).toBe(MAIN_SERVER_UUID)
  })

  it('imports into the uuid named and restores the selection', async () => {
    const mcp = await connect()
    const { server } = await stores()
    const { uuid } = JSON.parse(await ok(mcp, 'server_create', { name: 'second', port: 5020 }))
    server.getState().setSelectedUuid(uuid)
    server.getState().addBool('coils', 4)
    const json = await ok(mcp, 'server_export_config', { uuid })
    server.getState().setSelectedUuid(uuid)
    server.getState().clean(uuid)
    server.getState().setSelectedUuid(MAIN_SERVER_UUID)

    const answer = JSON.parse(await ok(mcp, 'server_import_config', { uuid, json }))

    expect(answer).toEqual({ imported: true, notes: [] })
    expect(server.getState().servers[uuid]?.registers['0']?.coils[4]).toBeDefined()
    expect(server.getState().servers[MAIN_SERVER_UUID]?.registers).toEqual({})
    expect(server.getState().selectedUuid).toBe(MAIN_SERVER_UUID)
  })

  it('answers an unknown uuid as an error', async () => {
    const mcp = await connect()
    await stores()

    const result = await call(mcp, 'server_import_config', { uuid: 'nope', json: '{}' })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('No server has uuid nope')
  })
})

describe('project_export and project_import', () => {
  it('exports the project and imports it back, replacing the servers', async () => {
    const mcp = await connect()
    const { client, server } = await stores()
    client.getState().setName('boiler')
    await ok(mcp, 'server_create', { name: 'second', port: 5020 })
    const json = await ok(mcp, 'project_export')
    expect(JSON.parse(json)).toMatchObject({ kind: 'project', version: 1 })

    client.getState().setName('changed')
    await ok(mcp, 'server_create', { name: 'third', port: 5021 })
    const answer = JSON.parse(await ok(mcp, 'project_import', { json }))

    expect(answer).toEqual({ imported: true, portsRefused: [], serversRefused: 0, notes: [] })
    expect(client.getState().name).toBe('boiler')
    expect(
      Object.values(server.getState().servers).map((entry) => [entry.name, entry.port])
    ).toEqual([
      ['', '502'],
      ['second', '5020']
    ])
  })

  it('answers a file that does not validate as an error', async () => {
    const mcp = await connect()
    await stores()

    const result = await call(mcp, 'project_import', { json: '{"kind":"project"}' })

    expect(result.isError).toBe(true)
  })
})

describe('the resources', () => {
  it('lists the schemas, the server list and each server config', async () => {
    const mcp = await connect()
    await stores()
    const { uuid } = JSON.parse(await ok(mcp, 'server_create', { port: 5020 }))

    const { resources } = await mcp.listResources()

    expect(resources.map((resource) => resource.uri)).toEqual(
      expect.arrayContaining([
        'modbux://schema/client-config',
        'modbux://schema/server-config',
        'modbux://schema/project',
        'modbux://server/list',
        `modbux://server/${MAIN_SERVER_UUID}/config`,
        `modbux://server/${uuid}/config`
      ])
    )
    const { resourceTemplates } = await mcp.listResourceTemplates()
    expect(resourceTemplates.map((template) => template.uriTemplate)).toContain(
      'modbux://server/{uuid}/config'
    )
  })

  it('reads a server config and the server list', async () => {
    const mcp = await connect()
    await stores()
    const { uuid } = JSON.parse(await ok(mcp, 'server_create', { name: 'sim', port: 5020 }))

    const config = await mcp.readResource({ uri: `modbux://server/${uuid}/config` })
    const list = await mcp.readResource({ uri: 'modbux://server/list' })

    expect(JSON.parse(String(config.contents[0]?.text))).toMatchObject({ name: 'sim', port: 5020 })
    expect(JSON.parse(String(list.contents[0]?.text)).selectedUuid).toBe(uuid)
  })

  it('rejects the config of a uuid no server has', async () => {
    const mcp = await connect()
    await stores()

    await expect(mcp.readResource({ uri: 'modbux://server/nope/config' })).rejects.toThrow(
      'No server has uuid nope'
    )
  })

  describe('the JSON Schemas', () => {
    const validator = (schema: object) => new Ajv({ strict: false }).compile(schema)

    it('accept the files the export tools answer', async () => {
      const mcp = await connect()
      const { client, server } = await stores()
      client.getState().setName('boiler')
      client.getState().setRegisterMapping(3, 'dataType', 'float')
      server.getState().addBool('coils', 2)
      const read = async (uri: string): Promise<object> =>
        JSON.parse(String((await mcp.readResource({ uri })).contents[0]?.text))

      const files = [
        ['modbux://schema/client-config', await ok(mcp, 'client_export_config')],
        [
          'modbux://schema/server-config',
          await ok(mcp, 'server_export_config', { uuid: MAIN_SERVER_UUID })
        ],
        ['modbux://schema/project', await ok(mcp, 'project_export')]
      ] as const
      for (const [uri, file] of files) {
        const validate = validator(await read(uri))
        expect(validate(JSON.parse(file)), `${uri}: ${JSON.stringify(validate.errors)}`).toBe(true)
      }
    })

    it('refuse a file of the wrong shape', () => {
      expect(validator(CLIENT_CONFIG_SCHEMA)({ version: 'three' })).toBe(false)
      expect(validator(SERVER_CONFIG_SCHEMA)({ version: 4, name: 7 })).toBe(false)
      expect(validator(PROJECT_SCHEMA)({ kind: 'project', servers: [] })).toBe(false)
    })
  })
})
