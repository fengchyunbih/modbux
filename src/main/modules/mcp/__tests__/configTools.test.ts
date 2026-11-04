/* eslint-disable @typescript-eslint/explicit-function-return-type */
// The config file, server and project tools against stand-in renderer
// commands: what each one sends, what it answers and how it is annotated.
// The real stores answer in `src/__tests__/mcpConfigTools.test.ts`.
import { describe, expect, it } from 'vitest'
import { MAIN_SERVER_UUID } from '@shared'
import { RendererCommandError } from '../../rendererCommands'
import { MAIN_WINDOW_CLOSED } from '../registry'
import { connectInMemory, fakeContext, jsonOf, textOf } from './fakeContext'

const FILE = '{\n  "version": 3,\n  "name": "meter"\n}'
const NOTES = { migrated: false, fromVersion: 3 }

const TOOLS = [
  'client_export_config',
  'client_import_config',
  'server_list',
  'server_create',
  'server_delete',
  'server_export_config',
  'server_import_config',
  'project_export',
  'project_import'
]

describe('the annotations', () => {
  it('mark exports and the list read only, and imports and delete destructive', async () => {
    const client = await connectInMemory(fakeContext())

    const { tools } = await client.listTools()
    const by = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]))

    for (const name of [
      'client_export_config',
      'server_list',
      'server_export_config',
      'project_export'
    ]) {
      expect(by[name], name).toMatchObject({ readOnlyHint: true, openWorldHint: false })
    }
    for (const name of [
      'client_import_config',
      'server_delete',
      'server_import_config',
      'project_import'
    ]) {
      expect(by[name], name).toMatchObject({ readOnlyHint: false, destructiveHint: true })
    }
    expect(by.server_create).toMatchObject({ readOnlyHint: false, destructiveHint: false })
    // They change what Modbux holds, never what a device holds.
    for (const name of TOOLS) expect(by[name]?.openWorldHint, name).toBe(false)
  })

  it('need no write permission, because no device is written', async () => {
    const context = fakeContext({
      client_import_config: async () => ({ ok: true, ...NOTES })
    })
    const client = await connectInMemory(context)

    const result = await client.callTool({
      name: 'client_import_config',
      arguments: { json: FILE }
    })

    expect(result.isError).toBeUndefined()
  })
})

describe('every config tool, with the main window closed', () => {
  it.each(TOOLS)('%s answers an error and reaches nothing', async (name) => {
    const context = fakeContext()
    context.setMainWindowOpen(false)
    const client = await connectInMemory(context)

    const result = await client.callTool({
      name,
      arguments: { uuid: 'u', json: '{}' }
    })

    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe(MAIN_WINDOW_CLOSED)
    expect(context.send).not.toHaveBeenCalled()
  })
})

describe('the exports', () => {
  it.each([
    ['client_export_config', 'client_export_config', {}],
    ['server_export_config', 'server_export_config', { uuid: 'abc' }],
    ['project_export', 'project_export', {}]
  ])('%s answers the file as it is, not wrapped', async (tool, command, args) => {
    const context = fakeContext({ [command]: async () => ({ json: FILE }) })
    const client = await connectInMemory(context)

    const result = await client.callTool({ name: tool, arguments: args })

    expect(textOf(result)).toBe(FILE)
    expect(context.send.mock.calls[0]).toEqual(
      Object.keys(args).length > 0 ? [command, args] : [command]
    )
  })

  it('answers a failed command as an error', async () => {
    const context = fakeContext({
      server_export_config: () =>
        Promise.reject(new RendererCommandError('failed', 'No server has uuid abc'))
    })
    const client = await connectInMemory(context)

    const result = await client.callTool({
      name: 'server_export_config',
      arguments: { uuid: 'abc' }
    })

    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('No server has uuid abc')
  })
})

describe('the imports', () => {
  it('client_import_config sends the json and answers the notes', async () => {
    const context = fakeContext({
      client_import_config: async () => ({
        ok: true,
        migrated: true,
        fromVersion: 2,
        wasMixedEndianness: true,
        futureVersion: { fields: ['registerConfig'], savedByNewerVersion: true }
      })
    })
    const client = await connectInMemory(context)

    const result = await client.callTool({
      name: 'client_import_config',
      arguments: { json: FILE }
    })

    expect(context.send).toHaveBeenCalledWith('client_import_config', { json: FILE })
    expect(jsonOf(result)).toEqual({
      imported: true,
      notes: [
        'The file was version 2 and was migrated.',
        'The file had mixed byte order settings. Verify the byte order.',
        'The file was saved by a newer version of Modbux.',
        'These fields could not be read and were reset: registerConfig.'
      ]
    })
  })

  it('answers a refused file as the error the renderer gave', async () => {
    const context = fakeContext({
      client_import_config: async () => ({ ok: false, error: 'Disconnect first' })
    })
    const client = await connectInMemory(context)

    const result = await client.callTool({
      name: 'client_import_config',
      arguments: { json: FILE }
    })

    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('Disconnect first')
  })

  it('server_import_config sends the uuid and answers portRefused', async () => {
    const context = fakeContext({
      server_import_config: async () => ({ ok: true, ...NOTES, portRefused: 5020 })
    })
    const client = await connectInMemory(context)

    const result = await client.callTool({
      name: 'server_import_config',
      arguments: { uuid: 'abc', json: FILE }
    })

    expect(context.send).toHaveBeenCalledWith('server_import_config', { uuid: 'abc', json: FILE })
    expect(jsonOf(result)).toEqual({ imported: true, portRefused: 5020, notes: [] })
  })

  it('project_import answers what was refused', async () => {
    const context = fakeContext({
      project_import: async () => ({
        ok: true,
        ...NOTES,
        portsRefused: [5020],
        serversRefused: 1
      })
    })
    const client = await connectInMemory(context)

    const result = await client.callTool({ name: 'project_import', arguments: { json: FILE } })

    expect(jsonOf(result)).toEqual({
      imported: true,
      portsRefused: [5020],
      serversRefused: 1,
      notes: []
    })
  })

  it('refuses an import with no json before it reaches the renderer', async () => {
    const context = fakeContext()
    const client = await connectInMemory(context)

    const result = await client.callTool({ name: 'project_import', arguments: {} })

    expect(result.isError).toBe(true)
    expect(context.send).not.toHaveBeenCalled()
  })
})

describe('the server tools', () => {
  it('server_list marks the main server', async () => {
    const context = fakeContext({
      server_list: async () => ({
        selectedUuid: 'b',
        servers: [
          { uuid: MAIN_SERVER_UUID, port: '502', unitId: '0' },
          { uuid: 'b', name: 'sim', port: '503', unitId: '0' }
        ]
      })
    })
    const client = await connectInMemory(context)

    const result = await client.callTool({ name: 'server_list', arguments: {} })

    expect(jsonOf(result)).toEqual({
      selectedUuid: 'b',
      servers: [
        { uuid: MAIN_SERVER_UUID, port: '502', unitId: '0', main: true },
        { uuid: 'b', name: 'sim', port: '503', unitId: '0', main: false }
      ]
    })
  })

  it.each([[{ port: 0 }], [{ port: 65536 }], [{ port: 502.5 }], [{ name: 3 }]])(
    'server_create refuses the arguments %j',
    async (args) => {
      const context = fakeContext()
      const client = await connectInMemory(context)

      const result = await client.callTool({ name: 'server_create', arguments: args })

      expect(result.isError).toBe(true)
      expect(context.send).not.toHaveBeenCalled()
    }
  )

  it('server_create sends name and port and answers the server', async () => {
    const server = { uuid: 'u', name: 'sim', port: '5020', unitId: '0' }
    const context = fakeContext({ server_create: async () => ({ ok: true, server }) })
    const client = await connectInMemory(context)

    const result = await client.callTool({
      name: 'server_create',
      arguments: { name: 'sim', port: 5020 }
    })

    expect(context.send).toHaveBeenCalledWith('server_create', { name: 'sim', port: 5020 })
    expect(jsonOf(result)).toEqual(server)
  })

  it('server_create and server_delete answer a refusal as an error', async () => {
    const context = fakeContext({
      server_create: async () => ({ ok: false, error: 'Modbux holds at most 10 servers' }),
      server_delete: async () => ({ ok: false, error: 'The main server cannot be deleted' })
    })
    const client = await connectInMemory(context)

    const created = await client.callTool({ name: 'server_create', arguments: {} })
    const deleted = await client.callTool({ name: 'server_delete', arguments: { uuid: 'x' } })

    expect([created.isError, textOf(created)]).toEqual([true, 'Modbux holds at most 10 servers'])
    expect([deleted.isError, textOf(deleted)]).toEqual([true, 'The main server cannot be deleted'])
  })
})
