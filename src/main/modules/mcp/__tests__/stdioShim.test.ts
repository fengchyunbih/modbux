/* eslint-disable @typescript-eslint/explicit-function-return-type */
// The shim in-process against the real MCP HTTP server on a port the kernel
// picks: an SDK client talks stdio-framed JSON to the shim over two streams.
import { PassThrough } from 'stream'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { McpSettings, MCP_HOST, MCP_PATH } from '@shared'
import { McpService } from '../mcpService'
import { McpSettingsStore } from '../settings'
import { findToken, startStdioShim, StdioShim, userDataDirectory } from '../stdioShim'
import { fakeContext, jsonOf } from './fakeContext'

const TOKEN = 'shim-token'

const services: McpService[] = []
const shims: StdioShim[] = []

afterEach(async () => {
  for (const shim of shims.splice(0)) await shim.close()
  for (const service of services.splice(0)) await service.stop()
})

const startService = async () => {
  let current: McpSettings = { enabled: true, allowWrites: false, token: TOKEN }
  const store: McpSettingsStore = { load: () => current, save: (next) => (current = next) }
  const service = new McpService({
    settings: store,
    context: fakeContext(),
    version: '0.0.0-test',
    port: 0
  })
  services.push(service)
  await service.start()
  return `http://${MCP_HOST}:${service.port}${MCP_PATH}`
}

/** A shim whose stdio is two streams, and an SDK client wired to the other ends. */
const connectThroughShim = async (url: string, token: string, log: string[] = []) => {
  const toShim = new PassThrough()
  const fromShim = new PassThrough()
  shims.push(
    await startStdioShim({ url, token, stdin: toShim, stdout: fromShim, log: (m) => log.push(m) })
  )

  const received = new ReadBuffer()
  const waiting: ((message: JSONRPCMessage) => void)[] = []
  const queue: JSONRPCMessage[] = []
  fromShim.on('data', (chunk: Buffer) => {
    received.append(chunk)
    for (let message = received.readMessage(); message; message = received.readMessage()) {
      const waiter = waiting.shift()
      if (waiter) waiter(message)
      else queue.push(message)
    }
  })
  const next = (): Promise<JSONRPCMessage> => {
    const message = queue.shift()
    return message ? Promise.resolve(message) : new Promise((resolve) => waiting.push(resolve))
  }
  const send = (message: JSONRPCMessage) => toShim.write(serializeMessage(message))
  return { send, next }
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'shim-test', version: '0' }
  }
} as const

describe('the stdio shim', () => {
  it('forwards initialize, then lists tools, resources and prompts from the endpoint', async () => {
    const url = await startService()
    const shim = await connectThroughShim(url, TOKEN)

    shim.send(initialize)
    const init = await shim.next()
    expect(init).toMatchObject({ id: 1, result: { serverInfo: { name: 'modbux' } } })
    shim.send({ jsonrpc: '2.0', method: 'notifications/initialized' })

    const asked = [
      ['tools/list', 2, 'tools'],
      ['resources/list', 3, 'resources'],
      ['prompts/list', 4, 'prompts']
    ] as const
    for (const [method, id, key] of asked) {
      shim.send({ jsonrpc: '2.0', id, method })
      const reply = (await shim.next()) as { id: number; result: Record<string, unknown[]> }
      expect(reply.id).toBe(id)
      expect(reply.result[key]?.length).toBeGreaterThan(0)
    }
  })

  it('forwards a tool call and its answer', async () => {
    const url = await startService()
    const shim = await connectThroughShim(url, TOKEN)
    shim.send(initialize)
    await shim.next()
    shim.send({ jsonrpc: '2.0', method: 'notifications/initialized' })

    shim.send({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'client_get_config', arguments: {} }
    })
    const reply = await shim.next()

    expect(reply).toMatchObject({ id: 9 })
    expect(jsonOf((reply as { result: unknown }).result)).toMatchObject({
      name: 'Meter on the bench'
    })
  })

  it('answers a request with an error when the token is wrong, so the client does not wait', async () => {
    const url = await startService()
    const log: string[] = []
    const shim = await connectThroughShim(url, 'not-the-token', log)

    shim.send(initialize)
    const reply = (await shim.next()) as { id: number; error: { code: number; message: string } }

    expect(reply.id).toBe(1)
    expect(reply.error.code).toBe(-32000)
    expect(reply.error.message).toContain('Modbux endpoint')
  })

  it('answers a request with an error when nothing listens', async () => {
    const shim = await connectThroughShim(`http://${MCP_HOST}:1${MCP_PATH}`, TOKEN)

    shim.send({ jsonrpc: '2.0', id: 5, method: 'tools/list' })
    const reply = (await shim.next()) as { id: number; error: { message: string } }

    expect(reply.id).toBe(5)
    expect(reply.error.message).toContain('Modbux endpoint')
  })
})

describe('findToken', () => {
  const settingsJson = (token: string) =>
    JSON.stringify({ version: 1, enabled: true, allowWrites: false, token })

  it('prefers MODBUX_MCP_TOKEN over the settings file', () => {
    const result = findToken({
      env: { MODBUX_MCP_TOKEN: ' from-env ' },
      readFile: () => settingsJson('from-file')
    })

    expect(result).toEqual({ token: 'from-env', source: 'MODBUX_MCP_TOKEN' })
  })

  it('reads mcp.json from the userData directory, Modbux before modbux', () => {
    const read: string[] = []
    const result = findToken({
      env: {},
      platform: 'linux',
      home: '/home/me',
      readFile: (path) => {
        read.push(path)
        if (path.includes('/modbux/')) return settingsJson('lowercase')
        throw new Error('ENOENT')
      }
    })

    expect(read).toEqual(['/home/me/.config/Modbux/mcp.json', '/home/me/.config/modbux/mcp.json'])
    expect(result).toEqual({ token: 'lowercase', source: '/home/me/.config/modbux/mcp.json' })
  })

  it('takes MODBUX_USER_DATA as the directory', () => {
    const result = findToken({
      env: { MODBUX_USER_DATA: '/profile' },
      readFile: (path) => {
        expect(path).toBe(join('/profile', 'mcp.json'))
        return settingsJson('t')
      }
    })

    expect(result).toMatchObject({ token: 't' })
  })

  it('says where it looked when there is no token', () => {
    const result = findToken({
      env: {},
      platform: 'linux',
      home: '/h',
      readFile: () => {
        throw new Error('ENOENT')
      }
    })

    expect(result).toMatchObject({ error: expect.stringContaining('/h/.config/Modbux/mcp.json') })
  })

  it('refuses a settings file with no token', () => {
    const result = findToken({ env: {}, readFile: () => '{"version":1}' })

    expect('error' in result).toBe(true)
  })
})

describe('userDataDirectory', () => {
  it('follows Electron per platform', () => {
    expect(userDataDirectory('Modbux', 'linux', {}, '/h')).toBe('/h/.config/Modbux')
    expect(userDataDirectory('Modbux', 'linux', { XDG_CONFIG_HOME: '/x' }, '/h')).toBe('/x/Modbux')
    expect(userDataDirectory('Modbux', 'darwin', {}, '/Users/me')).toBe(
      '/Users/me/Library/Application Support/Modbux'
    )
    expect(userDataDirectory('Modbux', 'win32', { APPDATA: 'C:\\A' }, 'C:\\U')).toBe(
      join('C:\\A', 'Modbux')
    )
  })
})
