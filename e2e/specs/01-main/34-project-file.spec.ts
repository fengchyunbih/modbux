/**
 * Project file: one client and every server in one file
 *
 * Save project on the home screen writes the client configuration, every
 * server with its registers, port and name, and the server view's mode and
 * serial settings. Open project replaces all of it: the servers in the file
 * are created, the ones it does not name are deleted. A client or server file
 * opened as a project, and a project opened in either, is refused by name.
 */
import { test, expect, resetApp } from '../../fixtures/electron-app'
import type { ElectronApplication, Page } from '@playwright/test'
import {
  clearClientConfig,
  loadClientConfig,
  loadServerConfig,
  navigateToClient,
  navigateToHome,
  navigateToServer
} from '../../fixtures/helpers'
import { evaluateMain } from '../../fixtures/launch'
import { resolve } from 'path'
import { tmpdir } from 'os'
import { readFile, unlink } from 'fs/promises'

const CONFIG_DIR = resolve(__dirname, '../../fixtures/config-files')
const CLIENT_FILE = resolve(CONFIG_DIR, 'client-basic.json')
const SERVER_FILE = resolve(CONFIG_DIR, 'server-basic.json')
const SERVER_FILE_2 = resolve(CONFIG_DIR, 'server-2.json')

const projectFile = resolve(tmpdir(), `modbux-project-${Date.now()}.json`)

const SECOND_PORT = '5031'

const field = (p: Page, testId: string): ReturnType<Page['locator']> =>
  p.getByTestId(testId).locator('input')

const typeServerPort = async (p: Page, port: string): Promise<void> => {
  const input = field(p, 'server-port-input')
  await input.click()
  await input.selectText()
  await input.pressSequentially(port)
  await input.blur()
  await expect(input).toHaveValue(port)
}

/** Clicks Save project and answers the JSON the download wrote to `path`. */
const saveProjectTo = async (
  app: ElectronApplication,
  p: Page,
  path: string
): Promise<Record<string, unknown>> => {
  await evaluateMain(() =>
    app.evaluate(({ session }, savePath) => {
      session.defaultSession.on('will-download', (_event, item) => {
        item.setSavePath(savePath)
      })
    }, path)
  )
  await p.getByTestId('save-project-btn').click()
  let text = ''
  await expect(async () => {
    text = await readFile(path, 'utf-8')
    expect(text.length).toBeGreaterThan(0)
  }).toPass({ timeout: 5000 })
  return JSON.parse(text)
}

const setBaudRate = async (p: Page, baudRate: string): Promise<void> => {
  await p.getByTestId('server-rtu-baudrate-select').click()
  await p.getByRole('option', { name: baudRate, exact: true }).click()
  await expect(p.getByTestId('server-rtu-baudrate-select')).toContainText(baudRate)
}

test.beforeAll(async ({ electronApp, mainPage }) => {
  await resetApp(electronApp, mainPage)
})

test.afterAll(async () => {
  await unlink(projectFile).catch(() => {})
})

test.describe.serial('Project file', () => {
  test('build a client and two servers, and RTU settings', async ({ mainPage }) => {
    await navigateToClient(mainPage)
    await loadClientConfig(mainPage, CLIENT_FILE)
    await field(mainPage, 'tcp-host-input').fill('10.1.2.3')
    await field(mainPage, 'tcp-port-input').fill('1502')
    await field(mainPage, 'client-unitid-input').fill('17')
    await expect(field(mainPage, 'client-unitid-input')).toHaveValue('17')

    await navigateToServer(mainPage)
    await loadServerConfig(mainPage, SERVER_FILE)
    await mainPage.getByTestId('add-server-btn').click()
    await expect(mainPage.locator('[data-testid^="select-server-"]')).toHaveCount(2)
    await typeServerPort(mainPage, SECOND_PORT)
    await loadServerConfig(mainPage, SERVER_FILE_2)
    await expect(mainPage.getByTestId('section-coils')).toContainText('(8)')
    await expect(field(mainPage, 'server-port-input')).toHaveValue(SECOND_PORT)

    await mainPage.getByTestId('server-mode-rtu-btn').click()
    await expect(mainPage.getByTestId('server-rtu-com-input')).toBeVisible()
    await setBaudRate(mainPage, '19200')
  })

  test('save project writes the client, both servers and the server view', async ({
    electronApp,
    mainPage
  }) => {
    await navigateToHome(mainPage)
    const project = await saveProjectTo(electronApp, mainPage, projectFile)

    expect(project.kind).toBe('project')
    expect(project.version).toBe(1)
    expect(project.serverMode).toBe('rtu')
    expect(project.serialConfig).toMatchObject({ options: { baudRate: '19200' } })
    expect(project.client).toMatchObject({
      name: 'Test Client',
      connectionConfig: { unitId: 17, tcp: { host: '10.1.2.3', options: { port: 1502 } } }
    })
    expect(project.servers).toMatchObject([
      { name: 'Basic Server', port: 502 },
      { name: 'Second Server', port: Number(SECOND_PORT) }
    ])
    // Switching to RTU selects the main server, which RTU serves.
    expect(project.selectedServer).toBe(0)
  })

  test('change the client, the servers and the mode', async ({ mainPage }) => {
    await navigateToServer(mainPage)
    await mainPage.getByTestId('server-mode-tcp-btn').click()
    await expect(mainPage.locator('[data-testid^="select-server-"]')).toHaveCount(2)
    await mainPage.getByTestId(`select-server-${SECOND_PORT}`).click()
    await mainPage.getByTestId('delete-server-btn').click()
    await expect(mainPage.locator('[data-testid^="select-server-"]')).toHaveCount(1)
    await mainPage.getByTestId('server-clear-btn').click()
    await expect(mainPage.getByTestId('section-holding_registers')).toContainText('(0)')
    await typeServerPort(mainPage, '5099')

    await navigateToClient(mainPage)
    await field(mainPage, 'tcp-host-input').fill('10.9.9.9')
    await field(mainPage, 'client-unitid-input').fill('1')
    await clearClientConfig(mainPage)
  })

  test('open project restores the client', async ({ mainPage }) => {
    await navigateToHome(mainPage)
    await mainPage.getByTestId('open-project-file-input').setInputFiles(projectFile)
    await expect(mainPage.locator('.notistack-SnackbarContainer')).toContainText(
      'Project opened successfully',
      { timeout: 10000 }
    )

    await navigateToClient(mainPage)
    await expect(field(mainPage, 'tcp-host-input')).toHaveValue('10.1.2.3')
    await expect(field(mainPage, 'tcp-port-input')).toHaveValue('1502')
    await expect(field(mainPage, 'client-unitid-input')).toHaveValue('17')
    await expect(field(mainPage, 'client-config-name-input')).toHaveValue('Test Client')
  })

  test('open project restores the server view mode and serial settings', async ({ mainPage }) => {
    await navigateToServer(mainPage)
    await expect(mainPage.getByTestId('server-mode-rtu-btn')).toHaveClass(/Mui-selected/)
    await expect(mainPage.getByTestId('server-rtu-baudrate-select')).toContainText('19200')
  })

  test('open project restores every server with its port and registers', async ({ mainPage }) => {
    await mainPage.getByTestId('server-mode-tcp-btn').click()
    await expect(mainPage.locator('[data-testid^="select-server-"]')).toHaveCount(2)

    await mainPage.getByTestId('select-server-502').click()
    await expect(field(mainPage, 'server-name-input')).toHaveValue('Basic Server')
    await expect(mainPage.getByTestId('section-holding_registers')).toContainText('(2)')
    await expect(mainPage.getByTestId('section-input_registers')).toContainText('(1)')

    await mainPage.getByTestId(`select-server-${SECOND_PORT}`).click()
    await expect(field(mainPage, 'server-name-input')).toHaveValue('Second Server')
    await expect(field(mainPage, 'server-port-input')).toHaveValue(SECOND_PORT)
    await expect(mainPage.getByTestId('section-coils')).toContainText('(8)')
    await expect(mainPage.getByTestId('section-holding_registers')).toContainText('(2)')
  })

  test('open project replaces the servers it does not name', async ({ mainPage }) => {
    await mainPage.getByTestId('add-server-btn').click()
    await expect(mainPage.locator('[data-testid^="select-server-"]')).toHaveCount(3)
    await navigateToHome(mainPage)

    await mainPage.getByTestId('open-project-file-input').setInputFiles(projectFile)
    await expect(mainPage.locator('.notistack-SnackbarContainer')).toContainText(
      'Project opened successfully',
      { timeout: 10000 }
    )

    await navigateToServer(mainPage)
    await mainPage.getByTestId('server-mode-tcp-btn').click()
    await expect(mainPage.locator('[data-testid^="select-server-"]')).toHaveCount(2)
  })
})

test.describe.serial('Project file of the wrong kind', () => {
  test('a client file opened as a project is refused by name', async ({ mainPage }) => {
    await navigateToHome(mainPage)
    await mainPage.getByTestId('open-project-file-input').setInputFiles(CLIENT_FILE)

    await expect(mainPage.locator('.notistack-SnackbarContainer')).toContainText(
      'This is a client configuration, not a project file',
      { timeout: 5000 }
    )
  })

  test('a server file opened as a project is refused by name', async ({ mainPage }) => {
    await mainPage.getByTestId('open-project-file-input').setInputFiles(SERVER_FILE)

    await expect(mainPage.locator('.notistack-SnackbarContainer')).toContainText(
      'This is a server configuration, not a project file',
      { timeout: 5000 }
    )
  })

  test('a project opened in the client is refused by name', async ({ mainPage }) => {
    await navigateToClient(mainPage)
    await mainPage.getByTestId('load-config-file-input').setInputFiles(projectFile)

    await expect(mainPage.locator('.notistack-SnackbarContainer')).toContainText(
      'This is a project file',
      { timeout: 5000 }
    )
  })

  test('a project opened on the server is refused by name', async ({ mainPage }) => {
    await navigateToServer(mainPage)
    await mainPage.getByTestId('server-open-file-input').setInputFiles(projectFile)

    await expect(mainPage.locator('.notistack-SnackbarContainer')).toContainText(
      'This is a project file',
      { timeout: 5000 }
    )
  })
})
