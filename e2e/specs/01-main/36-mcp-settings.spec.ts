/**
 * The MCP server, switched on from the settings page and driven from outside
 *
 * The settings page is reached from Home. Enabling MCP starts a listener on
 * 127.0.0.1:15502 that an MCP client reaches with the token the page shows;
 * disabling it closes the port. The test process is the MCP client, so the
 * requests here arrive the way Claude Code's would. A Modbus server is refused
 * the MCP port.
 */
import { test, expect, resetApp } from '../../fixtures/electron-app'
import type { Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { navigateToHome, navigateToServer } from '../../fixtures/helpers'

const MCP_URL = 'http://127.0.0.1:15502/mcp'

const initialize = (token?: string): Promise<Response> =>
  fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'e2e', version: '0' }
      }
    })
  })

const shownToken = async (p: Page): Promise<string> =>
  (await p.getByTestId('mcp-token').textContent()) ?? ''

/** Both switches off, through the app, whatever an earlier run left in the profile. */
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

// The dev profile is the one a developer's own Modbux uses, so the switch is
// left off whichever test failed.
test.afterAll(async ({ mainPage }) => {
  await switchOff(mainPage)
})

test.describe.serial('MCP settings', () => {
  test('home opens the settings, with MCP off', async ({ mainPage }) => {
    await navigateToHome(mainPage)
    await mainPage.getByTestId('home-settings-btn').click()

    await expect(mainPage.getByTestId('mcp-settings')).toBeVisible()
    await expect(mainPage.getByTestId('mcp-enabled-switch').locator('input')).not.toBeChecked()
    await expect(mainPage.getByTestId('mcp-allow-writes-switch').locator('input')).not.toBeChecked()
    await expect(mainPage.getByTestId('mcp-status')).toHaveText('Stopped')
    await expect(mainPage.getByTestId('mcp-url')).toHaveText(MCP_URL)
  })

  test('nothing listens while MCP is off', async () => {
    await expect(initialize()).rejects.toThrow()
  })

  test('enabling it shows it running, with the token and the Claude Code command', async ({
    mainPage
  }) => {
    await mainPage.getByTestId('mcp-enabled-switch').locator('input').check()

    await expect(mainPage.getByTestId('mcp-status')).toHaveText('Running')
    const token = await shownToken(mainPage)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    await expect(mainPage.getByTestId('mcp-claude-command')).toHaveText(
      `claude mcp add --transport http modbux ${MCP_URL} --header "Authorization: Bearer ${token}"`
    )
  })

  test('the settings page shows the stdio shim commands', async ({ mainPage }) => {
    await expect(mainPage.getByTestId('mcp-stdio-claude-command')).toContainText(
      'claude mcp add modbux'
    )
    await expect(mainPage.getByTestId('mcp-stdio-claude-command')).toContainText('mcpStdio.js')
    await expect(mainPage.getByTestId('mcp-stdio-command')).toContainText('mcpStdio.js')
  })

  test('a request without the token is refused', async () => {
    expect((await initialize()).status).toBe(401)
  })

  test('an MCP client lists the tools and reads the client configuration', async ({ mainPage }) => {
    const token = await shownToken(mainPage)
    const client = new Client({ name: 'e2e', version: '0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(MCP_URL), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } }
      })
    )

    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'client_get_config',
        'client_connect',
        'client_disconnect',
        'client_read_points'
      ])
    )

    const result = await client.callTool({ name: 'client_get_config', arguments: {} })
    expect(result.isError).toBeFalsy()
    const content = (result.content as { type: string; text: string }[])[0]
    const config = JSON.parse(content?.text ?? '{}')
    // What the window holds after `resetApp`: the defaults, and no connection.
    const expected = await mainPage.evaluate(() => window.api.getClientState())
    expect(config).toMatchObject({
      connectState: expected.connectState,
      connectionConfig: { protocol: 'ModbusTcp', tcp: { options: { port: 502 } } },
      readConfiguration: false
    })
    await client.close()
  })

  test('regenerating the token refuses the old one', async ({ mainPage }) => {
    const before = await shownToken(mainPage)

    await mainPage.getByTestId('mcp-regenerate-token-btn').click()

    await expect(mainPage.getByTestId('mcp-token')).not.toHaveText(before)
    expect((await initialize(before)).status).toBe(401)
    expect((await initialize(await shownToken(mainPage))).status).toBe(200)
  })

  test('disabling it closes the port', async ({ mainPage }) => {
    await mainPage.getByTestId('mcp-enabled-switch').locator('input').uncheck()

    await expect(mainPage.getByTestId('mcp-status')).toHaveText('Stopped')
    await expect(initialize(await shownToken(mainPage))).rejects.toThrow()
  })

  test('a Modbus server is refused the MCP port', async ({ mainPage }) => {
    await navigateToServer(mainPage)
    const input = mainPage.getByTestId('server-port-input').locator('input')
    await input.click()
    await input.selectText()
    await input.pressSequentially('15502')
    await input.blur()

    await expect(mainPage.getByText('Port 15502 is reserved for the MCP server')).toBeVisible()
    await expect(input).toHaveValue('502')
  })
})
