/**
 * A point table through MCP, from the server to the client and back
 *
 * MCP is switched on from the settings page and the test process is the MCP
 * client. `server_apply_point_table` turns the main server into a simulator of
 * a float with a scaling factor and an int32 in CDAB; `client_apply_point_table`
 * maps the same table onto the client, which connects to that server and reads
 * the engineering values the table gave it. `client_write` is refused while
 * "Allow writes to devices" is off and reaches the server once it is on.
 */
import { test, expect, resetApp } from '../../fixtures/electron-app'
import type { Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { expectCell, navigateToClient, navigateToHome } from '../../fixtures/helpers'

const MCP_URL = 'http://127.0.0.1:15502/mcp'

/** The main server's port after `resetApp`, which `e2e-ns` lets the test bind. */
const SERVER_PORT = 502

const TABLE = [
  {
    name: 'Voltage',
    address: 40001,
    dataType: 'float',
    scalingFactor: 0.1,
    unit: 'V',
    value: 230.5
  },
  { name: 'Energy', address: 40003, dataType: 'int32', byteOrder: 'CDAB', value: -123456 }
]

/** The table as the client takes it: the same points without the simulated values. */
const CLIENT_TABLE = TABLE.map(({ name, address, dataType, scalingFactor, unit, byteOrder }) => ({
  name,
  address,
  dataType,
  scalingFactor,
  unit,
  byteOrder
}))

let mcp: Client

const callTool = async (
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ isError: boolean; text: string }> => {
  const result = await mcp.callTool({ name, arguments: args })
  const content = (result.content as { type: string; text: string }[])[0]
  return { isError: result.isError === true, text: content?.text ?? '' }
}

const callOk = async (
  name: string,
  args: Record<string, unknown> = {}
): Promise<Record<string, unknown>> => {
  const result = await callTool(name, args)
  expect(result.isError, result.text).toBe(false)
  return JSON.parse(result.text)
}

/** The engineering value `client_read_points` answers per PDU address. */
const readValues = async (): Promise<Record<number, unknown>> => {
  const { rows } = (await callOk('client_read_points')) as {
    rows: { address: number; value?: unknown }[]
  }
  return Object.fromEntries(rows.map((row) => [row.address, row.value]))
}

const switchOff = async (p: Page): Promise<void> => {
  await p.evaluate(async () => {
    await window.api.setMcpEnabled(false)
    await window.api.setMcpAllowWrites(false)
  })
}

test.beforeAll(async ({ electronApp, mainPage }) => {
  await resetApp(electronApp, mainPage)
  await switchOff(mainPage)
})

// The dev profile is the one a developer's own Modbux uses, so the switches
// are left off whichever test failed.
test.afterAll(async ({ mainPage }) => {
  await mcp?.callTool({ name: 'client_disconnect', arguments: {} }).catch(() => undefined)
  await mcp?.close()
  await switchOff(mainPage)
})

test.describe.serial('MCP point table', () => {
  test('MCP is switched on in the settings', async ({ mainPage }) => {
    await navigateToHome(mainPage)
    await mainPage.getByTestId('home-settings-btn').click()
    await mainPage.getByTestId('mcp-enabled-switch').locator('input').check()
    await expect(mainPage.getByTestId('mcp-status')).toHaveText('Running')

    const token = (await mainPage.getByTestId('mcp-token').textContent()) ?? ''
    mcp = new Client({ name: 'e2e', version: '0' })
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(MCP_URL), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } }
      })
    )
  })

  test('server_apply_point_table makes the main server a simulator of the table', async () => {
    const applied = await callOk('server_apply_point_table', {
      port: SERVER_PORT,
      unitId: 0,
      notation: 'modicon',
      points: TABLE
    })

    expect(applied).toMatchObject({
      applied: true,
      byteOrder: 'CDAB',
      report: { accepted: 2, rejected: 0 }
    })

    const { units } = (await callOk('server_get_values', { port: SERVER_PORT, unitId: 0 })) as {
      units: { registers: { address: number; value: unknown }[] }[]
    }
    const values = Object.fromEntries(
      (units[0]?.registers ?? []).map((register) => [register.address, register.value])
    )
    // The raw values: 230.5 over a factor of 0.1, and the int32 as given.
    expect(values).toEqual({ 0: 2305, 2: -123456 })
  })

  test('client_apply_point_table maps the same table onto the client', async () => {
    await callOk('client_set_connection', {
      protocol: 'ModbusTcp',
      unitId: 0,
      tcp: { host: '127.0.0.1', options: { port: SERVER_PORT } }
    })

    const applied = await callOk('client_apply_point_table', {
      notation: 'modicon',
      points: CLIENT_TABLE
    })

    expect(applied).toMatchObject({
      applied: true,
      byteOrder: 'CDAB',
      window: { type: 'holding_registers', address: 0, length: 4 }
    })
  })

  test('the client reads back the engineering values the server was given', async ({
    mainPage
  }) => {
    expect(await callOk('client_connect')).toMatchObject({ connectState: 'connected' })

    await expect(async () => {
      expect(await readValues()).toMatchObject({ 0: 230.5, 2: -123456 })
    }).toPass({ timeout: 10000 })

    // -123456 is 0xFFFE1DC0, which CDAB lays out low word first. The grid
    // draws what the read answers while the client view is open.
    await navigateToClient(mainPage)
    await readValues()
    await expectCell(mainPage, 2, 'hex', '1DC0')
    await expectCell(mainPage, 3, 'hex', 'FFFE')
  })

  test('client_write is refused while writes to devices are off', async () => {
    const refused = await callTool('client_write', {
      address: 40001,
      notation: 'modicon',
      value: 240.5,
      dataType: 'float',
      scalingFactor: 0.1
    })

    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('Writing to devices is switched off')
    expect(await readValues()).toMatchObject({ 0: 230.5 })
  })

  test('client_write reaches the server once writes are allowed', async ({ mainPage }) => {
    await navigateToHome(mainPage)
    await mainPage.getByTestId('home-settings-btn').click()
    await mainPage.getByTestId('mcp-allow-writes-switch').locator('input').check()

    const written = await callOk('client_write', {
      address: 40001,
      notation: 'modicon',
      value: 240.5,
      dataType: 'float',
      scalingFactor: 0.1
    })
    expect(written).toMatchObject({ address: 0, byteOrder: 'CDAB', raw: 2405 })

    await expect(async () => {
      expect(await readValues()).toMatchObject({ 0: 240.5, 2: -123456 })
    }).toPass({ timeout: 10000 })
  })
})
