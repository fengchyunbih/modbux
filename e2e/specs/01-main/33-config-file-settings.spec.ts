/**
 * Config files carry the connection settings and the server port
 *
 * A client file from v3 on holds the connection and read settings, and opening
 * it applies them; a v2 file holds neither, and opening it leaves the ones on
 * screen. A server file from v4 on holds the port. A file asking for a byte
 * swap is refused by name.
 */
import { test, expect, resetApp } from '../../fixtures/electron-app'
import type { ElectronApplication, Page } from '@playwright/test'
import { navigateToClient, navigateToServer } from '../../fixtures/helpers'
import { evaluateMain } from '../../fixtures/launch'
import { resolve } from 'path'
import { tmpdir } from 'os'
import { readFile, unlink, writeFile } from 'fs/promises'

const CONFIG_DIR = resolve(__dirname, '../../fixtures/config-files')
const CLIENT_V2 = resolve(CONFIG_DIR, 'client-basic.json')
const SERVER_V2 = resolve(CONFIG_DIR, 'server-basic.json')

const clientFile = resolve(tmpdir(), `modbux-client-settings-${Date.now()}.json`)
const clientByteSwapFile = resolve(tmpdir(), `modbux-client-byteswap-${Date.now()}.json`)
const serverFile = resolve(tmpdir(), `modbux-server-port-${Date.now()}.json`)

/** Clicks a save button and answers the JSON the download wrote to `path`. */
const saveTo = async (
  app: ElectronApplication,
  p: Page,
  button: string,
  path: string
): Promise<Record<string, unknown>> => {
  await evaluateMain(() =>
    app.evaluate(({ session }, savePath) => {
      session.defaultSession.on('will-download', (_event, item) => {
        item.setSavePath(savePath)
      })
    }, path)
  )
  await p.getByTestId(button).click()
  let text = ''
  await expect(async () => {
    text = await readFile(path, 'utf-8')
    expect(text.length).toBeGreaterThan(0)
  }).toPass({ timeout: 5000 })
  return JSON.parse(text)
}

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

test.beforeAll(async ({ electronApp, mainPage }) => {
  await resetApp(electronApp, mainPage)
})

test.afterAll(async () => {
  for (const path of [clientFile, clientByteSwapFile, serverFile]) {
    await unlink(path).catch(() => {})
  }
})

test.describe.serial('Client config file with connection and read settings', () => {
  test('set the connection and the read address', async ({ mainPage }) => {
    await navigateToClient(mainPage)
    await mainPage.getByTestId('protocol-tcp-btn').click()
    await field(mainPage, 'tcp-host-input').fill('10.1.2.3')
    await field(mainPage, 'tcp-port-input').fill('1502')
    await field(mainPage, 'client-unitid-input').fill('17')
    await field(mainPage, 'reg-address-input').fill('40')
    await expect(field(mainPage, 'reg-address-input')).toHaveValue('40')
  })

  test('save writes them into a v3 file', async ({ electronApp, mainPage }) => {
    const config = await saveTo(electronApp, mainPage, 'save-config-btn', clientFile)

    expect(config.version).toBe(3)
    expect(config.byteSwap).toBe(false)
    expect(config.connectionConfig).toMatchObject({
      protocol: 'ModbusTcp',
      unitId: 17,
      tcp: { host: '10.1.2.3', options: { port: 1502 } }
    })
    expect(config.registerConfig).toMatchObject({ address: 40 })
  })

  test('open applies them over other settings', async ({ mainPage }) => {
    await field(mainPage, 'tcp-host-input').fill('10.9.9.9')
    await field(mainPage, 'tcp-port-input').fill('502')
    await field(mainPage, 'client-unitid-input').fill('1')
    await field(mainPage, 'reg-address-input').fill('0')
    await expect(field(mainPage, 'reg-address-input')).toHaveValue('0')

    await mainPage.getByTestId('load-config-file-input').setInputFiles(clientFile)

    await expect(field(mainPage, 'tcp-host-input')).toHaveValue('10.1.2.3')
    await expect(field(mainPage, 'tcp-port-input')).toHaveValue('1502')
    await expect(field(mainPage, 'client-unitid-input')).toHaveValue('17')
    await expect(field(mainPage, 'reg-address-input')).toHaveValue('40')
  })

  test('a v2 file opens its mapping and leaves the settings on screen', async ({ mainPage }) => {
    await mainPage.getByTestId('load-config-file-input').setInputFiles(CLIENT_V2)

    await expect(field(mainPage, 'client-config-name-input')).toHaveValue('Test Client')
    await expect(field(mainPage, 'tcp-host-input')).toHaveValue('10.1.2.3')
    await expect(field(mainPage, 'tcp-port-input')).toHaveValue('1502')
    await expect(field(mainPage, 'client-unitid-input')).toHaveValue('17')
    await expect(field(mainPage, 'reg-address-input')).toHaveValue('40')
  })

  test('a file asking for a byte swap is refused and changes nothing', async ({ mainPage }) => {
    const config = JSON.parse(await readFile(clientFile, 'utf-8'))
    await writeFile(
      clientByteSwapFile,
      JSON.stringify({
        ...config,
        name: 'swapped',
        byteSwap: true,
        connectionConfig: { ...config.connectionConfig, unitId: 99 }
      })
    )

    await mainPage.getByTestId('load-config-file-input').setInputFiles(clientByteSwapFile)

    await expect(mainPage.locator('.notistack-SnackbarContainer')).toContainText(
      'byte swap (BADC or DCBA) is not supported',
      { timeout: 5000 }
    )
    await expect(field(mainPage, 'client-config-name-input')).toHaveValue('Test Client')
    await expect(field(mainPage, 'client-unitid-input')).toHaveValue('17')
  })
})

test.describe.serial('Server config file with a port', () => {
  test('set the port', async ({ mainPage }) => {
    await navigateToServer(mainPage)
    await typeServerPort(mainPage, '5021')
  })

  test('save writes it into a v4 file', async ({ electronApp, mainPage }) => {
    const config = await saveTo(electronApp, mainPage, 'server-save-btn', serverFile)

    expect(config.version).toBe(4)
    expect(config.byteSwap).toBe(false)
    expect(config.port).toBe(5021)
  })

  test('open moves the server back to it', async ({ mainPage }) => {
    await typeServerPort(mainPage, '5022')

    await mainPage.getByTestId('server-open-file-input').setInputFiles(serverFile)

    await expect(field(mainPage, 'server-port-input')).toHaveValue('5021')
  })

  test('a v2 file opens its registers and leaves the port', async ({ mainPage }) => {
    await typeServerPort(mainPage, '5023')

    await mainPage.getByTestId('server-open-file-input').setInputFiles(SERVER_V2)

    await expect(field(mainPage, 'server-name-input')).toHaveValue('Basic Server')
    await expect(mainPage.getByTestId('section-holding_registers')).toContainText('(2)')
    await expect(field(mainPage, 'server-port-input')).toHaveValue('5023')
  })
})
