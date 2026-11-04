/* eslint-disable @typescript-eslint/explicit-function-return-type */
// The MCP server over real HTTP on 127.0.0.1, on a port the kernel picks.
// `fetch` sends what a hostile page or a misconfigured client would; the SDK's
// own client is the well-behaved one.
import { createServer, Server } from 'http'
import type { AddressInfo } from 'net'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { MCP_HOST, MCP_PATH, McpSettings, McpStatus } from '@shared'
import { carriesToken, isLocalOrigin } from '../httpServer'
import { McpService } from '../mcpService'
import { McpSettingsStore } from '../settings'
import { CONFIG, fakeContext, jsonOf } from './fakeContext'

const TOKEN = 'the-token'

/** Settings kept in memory, with every save recorded. */
const memorySettings = (initial: Partial<McpSettings> = {}) => {
  const saved: McpSettings[] = []
  let current: McpSettings = { enabled: false, allowWrites: false, token: TOKEN, ...initial }
  const store: McpSettingsStore = {
    load: () => current,
    save: (settings) => {
      current = settings
      saved.push(settings)
    }
  }
  return { store, saved }
}

const services: McpService[] = []
const blockers: Server[] = []

afterEach(async () => {
  for (const service of services.splice(0)) await service.stop()
  for (const blocker of blockers.splice(0)) await new Promise((resolve) => blocker.close(resolve))
})

const startService = async (
  initial: Partial<McpSettings> = { enabled: true },
  { port = 0, context = fakeContext() } = {}
) => {
  const { store, saved } = memorySettings(initial)
  const statuses: McpStatus[] = []
  const service = new McpService({
    settings: store,
    context,
    version: '0.0.0-test',
    port,
    onStatus: (status) => statuses.push(status),
    createToken: () => 'a-new-token'
  })
  services.push(service)
  const status = await service.start()
  return {
    service,
    status,
    statuses,
    saved,
    context,
    url: `http://${MCP_HOST}:${service.port}${MCP_PATH}`
  }
}

const initializeBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'fetch', version: '0' }
  }
})

const post = (url: string, headers: Record<string, string>) =>
  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers
    },
    body: initializeBody
  })

/** A port nothing listened on a moment ago. */
const freePort = async (): Promise<number> => {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, MCP_HOST, resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise((resolve) => probe.close(resolve))
  return port
}

const sdkClient = async (url: string, token: string): Promise<Client> => {
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
  )
  return client
}

describe('isLocalOrigin', () => {
  it.each(['http://localhost:5173', 'http://127.0.0.1', 'https://[::1]:8080'])(
    'takes %s',
    (origin) => expect(isLocalOrigin(origin)).toBe(true)
  )

  it.each([
    'http://evil.example',
    'http://localhost.evil.example',
    'http://127.0.0.1.evil.example',
    'null',
    'file://',
    'chrome-extension://abc',
    'ftp://localhost'
  ])('refuses %s', (origin) => expect(isLocalOrigin(origin)).toBe(false))
})

describe('carriesToken', () => {
  it('takes the token after Bearer', () => expect(carriesToken('Bearer abc', 'abc')).toBe(true))

  it.each([
    undefined,
    '',
    'abc',
    'Bearer ',
    'Bearer abd',
    'Bearer abcd',
    'Basic abc',
    'bearer abc'
  ])('refuses %s', (header) => expect(carriesToken(header, 'abc')).toBe(false))
})

describe('the HTTP endpoint', () => {
  it('listens on 127.0.0.1 alone', async () => {
    const { service } = await startService()
    const address = (service as unknown as { _server: Server })._server.address() as AddressInfo

    expect(address.address).toBe('127.0.0.1')
  })

  it('answers a request with the token', async () => {
    const { url } = await startService()

    const response = await post(url, { Authorization: `Bearer ${TOKEN}` })

    expect(response.status).toBe(200)
  })

  it('refuses a request without a token with 401', async () => {
    const { url } = await startService()

    const response = await post(url, {})

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe('Bearer')
  })

  it('refuses a request with the wrong token with 401', async () => {
    const { url } = await startService()

    expect((await post(url, { Authorization: 'Bearer not-the-token' })).status).toBe(401)
  })

  // A page the user has open in a browser can reach 127.0.0.1, and the
  // browser names that page in Origin. The token check comes after, so the
  // refusal holds even for a page that somehow has the token.
  it('refuses a foreign Origin with 403, token or not', async () => {
    const { url } = await startService()

    const response = await post(url, {
      Authorization: `Bearer ${TOKEN}`,
      Origin: 'http://evil.example'
    })

    expect(response.status).toBe(403)
  })

  it('takes a localhost Origin', async () => {
    const { url } = await startService()

    const response = await post(url, {
      Authorization: `Bearer ${TOKEN}`,
      Origin: 'http://localhost:3000'
    })

    expect(response.status).toBe(200)
  })

  it('answers another path with 404', async () => {
    const { service } = await startService()

    const response = await post(`http://${MCP_HOST}:${service.port}/other`, {
      Authorization: `Bearer ${TOKEN}`
    })

    expect(response.status).toBe(404)
  })

  it('answers a GET with 405, because no session holds a stream open', async () => {
    const { url } = await startService()

    const response = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } })

    expect(response.status).toBe(405)
  })
})

describe('the SDK client against the endpoint', () => {
  it('initializes, lists the tools and calls client_get_config', async () => {
    const { url, context } = await startService()
    const client = await sdkClient(url, TOKEN)

    expect(client.getServerVersion()).toMatchObject({ name: 'modbux', version: '0.0.0-test' })
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toContain('client_get_config')

    const result = await client.callTool({ name: 'client_get_config', arguments: {} })
    expect(jsonOf(result)).toEqual({ ...CONFIG, connectState: 'disconnected' })
    expect(context.send).toHaveBeenCalledWith('client_get_config')
    await client.close()
  })
})

describe('the switches', () => {
  it('leaves nothing listening while MCP is off', async () => {
    const port = await freePort()
    const { status, url } = await startService({ enabled: false }, { port })

    expect(status.state).toBe('stopped')
    expect(url).toBe(`http://${MCP_HOST}:${port}${MCP_PATH}`)
    await expect(post(url, { Authorization: `Bearer ${TOKEN}` })).rejects.toThrow()
  })

  it('starts on enable and stops on disable, saving each', async () => {
    const { service, saved } = await startService({ enabled: false })

    const running = await service.setEnabled(true)
    expect(running.state).toBe('running')
    const url = `http://${MCP_HOST}:${service.port}${MCP_PATH}`
    expect((await post(url, { Authorization: `Bearer ${TOKEN}` })).status).toBe(200)

    const stopped = await service.setEnabled(false)
    expect(stopped.state).toBe('stopped')
    await expect(post(url, { Authorization: `Bearer ${TOKEN}` })).rejects.toThrow()

    expect(saved.map((settings) => settings.enabled)).toEqual([true, false])
  })

  it('reports a port in use, and listens on nothing else', async () => {
    const blocker = createServer()
    blockers.push(blocker)
    await new Promise<void>((resolve) => blocker.listen(0, MCP_HOST, resolve))
    const taken = (blocker.address() as AddressInfo).port

    const { status, statuses, service } = await startService({ enabled: true }, { port: taken })

    expect(status).toMatchObject({
      state: 'error',
      error: `Port ${taken} is already in use, so MCP is not running`,
      enabled: true
    })
    expect(statuses.at(-1)).toEqual(status)
    expect((service as unknown as { _server: unknown })._server).toBeUndefined()
  })

  it('clears the error once MCP is switched off', async () => {
    const blocker = createServer()
    blockers.push(blocker)
    await new Promise<void>((resolve) => blocker.listen(0, MCP_HOST, resolve))
    const taken = (blocker.address() as AddressInfo).port
    const { service } = await startService({ enabled: true }, { port: taken })

    const status = await service.setEnabled(false)

    expect(status.state).toBe('stopped')
    expect(status.error).toBeUndefined()
  })

  it('saves and announces allow writes, and hands it to the tools', async () => {
    const { service, saved, statuses } = await startService()

    const status = service.setAllowWrites(true)

    expect(status.allowWrites).toBe(true)
    expect(saved.at(-1)?.allowWrites).toBe(true)
    expect(statuses.at(-1)?.allowWrites).toBe(true)
    const context = (service as unknown as { _context: { allowWrites: () => boolean } })._context
    expect(context.allowWrites()).toBe(true)
  })

  it('refuses the old token and takes the new one once it is regenerated', async () => {
    const { service, url, saved } = await startService()

    const status = service.regenerateToken()

    expect(status.token).toBe('a-new-token')
    expect(saved.at(-1)?.token).toBe('a-new-token')
    expect((await post(url, { Authorization: `Bearer ${TOKEN}` })).status).toBe(401)
    expect((await post(url, { Authorization: 'Bearer a-new-token' })).status).toBe(200)
  })
})

describe('a tool call with the main window closed, over HTTP', () => {
  it('answers isError naming the window', async () => {
    const context = fakeContext()
    context.setMainWindowOpen(false)
    const { url } = await startService({ enabled: true }, { context })
    const client = await sdkClient(url, TOKEN)

    const result = await client.callTool({ name: 'client_get_config', arguments: {} })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('The Modbux main window is not open')
    await client.close()
  })
})
