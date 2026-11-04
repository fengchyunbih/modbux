/**
 * The MCP scan tools against a Modbus server in the same app
 *
 * `server-integration.json` holds, at unit id 0, holding registers 0 to 7 as
 * int16 -100 (FF9C), uint16 500 (01F4), int32 -70000 (FFFE EE90), uint32
 * 100000 (0001 86A0) and float 3.14 (4048 F5C3). The test process is the MCP
 * client: it enables MCP, connects the window's client to the server, and
 * scans through `client_scan_registers` and `client_scan_unit_ids`.
 */
import { test, expect, resetApp } from '../../fixtures/electron-app'
import type { Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { spawn } from 'child_process'
import { resolve } from 'path'
import {
  cleanServerState,
  connectClient,
  disconnectClient,
  loadServerConfig,
  navigateToClient,
  selectUnitId
} from '../../fixtures/helpers'

const SERVER_CONFIG = resolve(__dirname, '../../fixtures/config-files/server-integration.json')
const SHIM = resolve(__dirname, '../../../out/main/mcpStdio.js')
const MCP_URL = 'http://127.0.0.1:15502/mcp'

const WORDS: [number, number][] = [
  [0, 0xff9c],
  [1, 0x01f4],
  [2, 0xfffe],
  [3, 0xee90],
  [4, 0x0001],
  [5, 0x86a0],
  [6, 0x4048],
  [7, 0xf5c3]
]

const switchOff = async (p: Page): Promise<void> => {
  await p.evaluate(async () => {
    await window.api.setMcpEnabled(false)
    await window.api.setMcpAllowWrites(false)
  })
}

/** What a tool answered: the error flag and the JSON or text it carried. */
const call = async (
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<{ isError: boolean; text: string; json: Record<string, unknown> }> => {
  const result = await client.callTool({ name, arguments: args })
  const content = (result.content as { type: string; text: string }[])[0]
  const text = content?.text ?? ''
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(text)
  } catch {
    // An error is plain text.
  }
  return { isError: result.isError === true, text, json }
}

let client: Client

test.beforeAll(async ({ electronApp, mainPage }) => {
  await resetApp(electronApp, mainPage)
  await switchOff(mainPage)
})

test.afterAll(async ({ mainPage }) => {
  await client?.close().catch(() => undefined)
  await switchOff(mainPage)
})

test.describe.serial('MCP scan tools', () => {
  test('enable MCP and connect an MCP client', async ({ mainPage }) => {
    const status = await mainPage.evaluate(() => window.api.setMcpEnabled(true))
    expect(status.state).toBe('running')

    client = new Client({ name: 'e2e', version: '0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(MCP_URL), {
        requestInit: { headers: { Authorization: `Bearer ${status.token}` } }
      })
    )
    const { tools } = await client.listTools()
    const scans = tools.filter((tool) => tool.name.startsWith('client_scan_'))
    expect(scans.map((tool) => [tool.name, tool.annotations?.readOnlyHint])).toEqual([
      ['client_scan_registers', true],
      ['client_scan_unit_ids', true]
    ])
  })

  test('the default server holds registers', async ({ mainPage }) => {
    await cleanServerState(mainPage)
    await loadServerConfig(mainPage, SERVER_CONFIG)
    await expect(mainPage.getByTestId('section-holding_registers')).toContainText('(12)')
    await mainPage.getByTestId('select-server-502').click()
    await selectUnitId(mainPage, '0')
  })

  test('a scan while disconnected is refused', async () => {
    const result = await call(client, 'client_scan_registers', {
      registerType: 'holding_registers',
      startAddress: 0,
      count: 8
    })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('client_connect')
  })

  test('connect the window client to the server', async ({ mainPage }) => {
    await navigateToClient(mainPage)
    await connectClient(mainPage, '127.0.0.1', '502', '0')
  })

  test('client_scan_registers answers the addresses that hold a value', async () => {
    const result = await call(client, 'client_scan_registers', {
      registerType: 'holding_registers',
      startAddress: 0,
      count: 8,
      chunkSize: 4
    })

    expect(result.isError).toBe(false)
    expect(result.json).toMatchObject({
      unitId: 0,
      registerType: 'holding_registers',
      range: [0, 7],
      foundCount: 8,
      stopped: false,
      truncated: false
    })
    const found = result.json.found as { address: number; word: number }[]
    expect(found.map((row) => [row.address, row.word])).toEqual(WORDS)
  })

  test('an empty range answers nothing found', async () => {
    const result = await call(client, 'client_scan_registers', {
      registerType: 'holding_registers',
      startAddress: 1000,
      count: 20
    })

    expect(result.isError).toBe(false)
    expect(result.json).toMatchObject({ foundCount: 0, found: [] })
  })

  test('a range past the last address is refused', async () => {
    const result = await call(client, 'client_scan_registers', {
      startAddress: 65530,
      count: 100
    })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('65535')
  })

  test('client_scan_unit_ids finds the unit the server answers for', async () => {
    const result = await call(client, 'client_scan_unit_ids', {
      startUnitId: 0,
      endUnitId: 2,
      registerTypes: ['holding_registers'],
      timeoutMs: 300
    })

    expect(result.isError).toBe(false)
    expect(result.json).toMatchObject({ unitsAsked: 3, stopped: false })
    const replied = result.json.replied as { unitId: number }[]
    expect(replied.map((unit) => unit.unitId)).toContain(0)
  })

  test('the stdio shim forwards a scan to the running app', async ({ mainPage }) => {
    const { token } = await mainPage.evaluate(() => window.api.getMcpStatus())
    const shim = spawn('node', [SHIM], {
      env: { ...process.env, MODBUX_MCP_TOKEN: token },
      stdio: ['pipe', 'pipe', 'inherit']
    })
    interface Reply {
      id?: number
      result: { prompts: { name: string }[]; content: { text: string }[] }
    }
    const replies: Reply[] = []
    let pending = ''
    shim.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString()
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines.filter(Boolean)) replies.push(JSON.parse(line))
    })
    const send = (message: Record<string, unknown>): void =>
      void shim.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
    const reply = async (id: number): Promise<Reply> => {
      await expect.poll(() => replies.some((r) => r.id === id)).toBe(true)
      const found = replies.find((r) => r.id === id)
      if (!found) throw new Error(`no reply to ${id}`)
      return found
    }

    try {
      send({
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'e2e-shim', version: '0' }
        }
      })
      await reply(1)
      send({ method: 'notifications/initialized' })

      send({ id: 2, method: 'prompts/list' })
      const { prompts } = (await reply(2)).result
      expect(prompts.map((prompt) => prompt.name)).toEqual([
        'point_table_to_client',
        'point_table_to_simulator',
        'closed_loop_test'
      ])

      send({
        id: 3,
        method: 'tools/call',
        params: {
          name: 'client_scan_registers',
          arguments: { registerType: 'holding_registers', startAddress: 0, count: 8 }
        }
      })
      const scan = JSON.parse((await reply(3)).result.content[0]?.text ?? '{}')
      expect(scan.found.map((row: { address: number }) => row.address)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7
      ])
    } finally {
      shim.kill()
    }
  })

  test('a scan after the disconnect is refused again', async ({ mainPage }) => {
    await disconnectClient(mainPage)

    const result = await call(client, 'client_scan_unit_ids', { startUnitId: 0, endUnitId: 1 })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('client_connect')
  })
})
