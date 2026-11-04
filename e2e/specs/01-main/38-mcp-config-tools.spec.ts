/**
 * The config file, server and project tools of the MCP server
 *
 * The test process is the MCP client. A server made through `server_create`
 * shows up in the server view as it would after the Add button; `project_export`
 * and `project_import` carry the client and every server out and back, and the
 * views show what came in. The tools write no device, so "Allow writes to
 * devices" stays off.
 */
import { test, expect, resetApp } from '../../fixtures/electron-app'
import type { Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { navigateToClient, navigateToServer } from '../../fixtures/helpers'

const MCP_URL = 'http://127.0.0.1:15502/mcp'

let mcp: Client

const callTool = async (
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ isError: boolean; text: string }> => {
  const result = await mcp.callTool({ name, arguments: args })
  const content = (result.content as { type: string; text: string }[])[0]
  return { isError: result.isError === true, text: content?.text ?? '' }
}

const callOk = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
  const result = await callTool(name, args)
  expect(result.isError, result.text).toBe(false)
  return result.text
}

const switchOff = async (p: Page): Promise<void> => {
  await p.evaluate(async () => {
    await window.api.setMcpEnabled(false)
    await window.api.setMcpAllowWrites(false)
  })
}

test.beforeAll(async ({ electronApp, mainPage }) => {
  await resetApp(electronApp, mainPage)
  const token = await mainPage.evaluate(async () => {
    await window.api.setMcpAllowWrites(false)
    return (await window.api.setMcpEnabled(true))?.token
  })
  expect(token).toBeTruthy()
  mcp = new Client({ name: 'e2e', version: '0' })
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
  )
})

// The dev profile is the one a developer's own Modbux uses, so the switch is
// left off whichever test failed.
test.afterAll(async ({ mainPage }) => {
  await mcp?.close()
  await switchOff(mainPage)
})

test.describe.serial('MCP config tools', () => {
  test('lists the config tools', async () => {
    const { tools } = await mcp.listTools()
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'client_export_config',
        'client_import_config',
        'server_list',
        'server_create',
        'server_delete',
        'server_export_config',
        'server_import_config',
        'project_export',
        'project_import'
      ])
    )
  })

  test('server_create adds a server to the server view', async ({ mainPage }) => {
    await navigateToServer(mainPage)
    await expect(mainPage.getByTestId('select-server-5040')).toHaveCount(0)

    const created = JSON.parse(await callOk('server_create', { name: 'Meter sim', port: 5040 }))

    expect(created).toMatchObject({ name: 'Meter sim', port: '5040' })
    await expect(mainPage.getByTestId('select-server-5040')).toBeVisible()
    await expect(mainPage.getByTestId('server-name-input').locator('input')).toHaveValue(
      'Meter sim'
    )
    const list = JSON.parse(await callOk('server_list'))
    expect(list.servers.map((server: { port: string }) => server.port)).toEqual(['502', '5040'])
  })

  test('server_create refuses the MCP port and a port another server holds', async ({
    mainPage
  }) => {
    expect((await callTool('server_create', { port: 15502 })).text).toContain(
      'Port 15502 is reserved for the MCP server'
    )
    expect((await callTool('server_create', { port: 5040 })).isError).toBe(true)
    await expect(mainPage.getByTestId('select-server-15502')).toHaveCount(0)
  })

  test('server_import_config fills a server by uuid and leaves the selection alone', async ({
    mainPage
  }) => {
    const { servers } = JSON.parse(await callOk('server_list'))
    const [first, second] = servers as { uuid: string }[]
    // Select the main server, so the import into the other one has a selection to leave.
    await navigateToServer(mainPage)
    await mainPage.getByTestId('select-server-502').click()
    const file = JSON.parse(await callOk('server_export_config', { uuid: second?.uuid }))
    file.name = 'Imported name'
    file.port = 5041

    const answer = JSON.parse(
      await callOk('server_import_config', { uuid: second?.uuid, json: JSON.stringify(file) })
    )

    expect(answer).toMatchObject({ imported: true })
    await expect(mainPage.getByTestId('select-server-5041')).toBeVisible()
    await expect(mainPage.getByTestId('select-server-5040')).toHaveCount(0)
    expect(JSON.parse(await callOk('server_list')).selectedUuid).toBe(first?.uuid)
  })

  test('client_import_config sets the client name shown in the client view', async ({
    mainPage
  }) => {
    const file = JSON.parse(await callOk('client_export_config'))
    file.name = 'Imported by MCP'

    await callOk('client_import_config', { json: JSON.stringify(file) })

    await navigateToClient(mainPage)
    await expect(mainPage.getByTestId('client-config-name-input').locator('input')).toHaveValue(
      'Imported by MCP'
    )
  })

  test('project_import brings back what project_export took out', async ({ mainPage }) => {
    const project = await callOk('project_export')
    expect(JSON.parse(project)).toMatchObject({ kind: 'project' })

    const { servers } = JSON.parse(await callOk('server_list'))
    const second = (servers as { uuid: string; main: boolean }[]).find((server) => !server.main)
    await callOk('server_delete', { uuid: second?.uuid })
    await navigateToServer(mainPage)
    await expect(mainPage.getByTestId('select-server-5041')).toHaveCount(0)
    await navigateToClient(mainPage)
    await mainPage.getByTestId('client-config-name-input').locator('input').fill('Typed by hand')

    const answer = JSON.parse(await callOk('project_import', { json: project }))

    expect(answer).toMatchObject({ imported: true, portsRefused: [], serversRefused: 0 })
    await expect(mainPage.getByTestId('client-config-name-input').locator('input')).toHaveValue(
      'Imported by MCP'
    )
    await navigateToServer(mainPage)
    await expect(mainPage.getByTestId('select-server-5041')).toBeVisible()
  })

  test('server_delete removes a server and refuses the main one', async ({ mainPage }) => {
    const { servers } = JSON.parse(await callOk('server_list'))
    const [main, second] = servers as { uuid: string; main: boolean }[]
    expect(main?.main).toBe(true)

    expect((await callTool('server_delete', { uuid: main?.uuid })).text).toBe(
      'The main server cannot be deleted'
    )
    await callOk('server_delete', { uuid: second?.uuid })

    await expect(mainPage.getByTestId('select-server-5041')).toHaveCount(0)
    await expect(mainPage.getByTestId('select-server-502')).toBeVisible()
  })

  test('the schema resources are served', async () => {
    const { contents } = await mcp.readResource({ uri: 'modbux://schema/project' })
    const [content] = contents
    const text = content && 'text' in content ? content.text : ''
    expect(JSON.parse(text)).toMatchObject({ type: 'object' })
  })
})
