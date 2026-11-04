/**
 * Byte swap end to end: the server encodes in BADC or DCBA, and the client
 * reads the value back only when it reads in the same order.
 *
 * `server-integration.json` holds INT32 -70000 at 2 (ABCD FFFE EE90) and FLOAT
 * 3.14 at 6 (ABCD 4048 F5C3).
 */
import { test, expect, resetApp } from '../../fixtures/electron-app'
import {
  selectUnitId,
  cellLocator,
  readRegisters,
  clearData,
  loadServerConfig,
  connectClient,
  disconnectClient,
  navigateToServer,
  navigateToClient,
  enableAdvancedMode,
  cleanServerState,
  setServerEndianness,
  setClientEndianness,
  expectCell,
  expectCellContains
} from '../../fixtures/helpers'
import { resolve } from 'path'

const SERVER_CONFIG = resolve(__dirname, '../../fixtures/config-files/server-integration.json')

test.beforeAll(async ({ electronApp, mainPage }) => {
  await resetApp(electronApp, mainPage)
})

test.describe.serial('Byte swap — BADC and DCBA round-trip', () => {
  test('clean server state', async ({ mainPage }) => {
    await cleanServerState(mainPage)
  })

  test('load server config', async ({ mainPage }) => {
    await loadServerConfig(mainPage, SERVER_CONFIG)
    await expect(mainPage.getByTestId('section-holding_registers')).toContainText('(12)')
  })

  // ─── BADC ──────────────────────────────────────────────────────────

  test('switch server 1 to BADC', async ({ mainPage }) => {
    await mainPage.getByTestId('select-server-502').click()
    await selectUnitId(mainPage, '0')
    await setServerEndianness(mainPage, 'badc')
  })

  test('connect the client and read in BADC', async ({ mainPage }) => {
    await navigateToClient(mainPage)
    await enableAdvancedMode(mainPage)
    await connectClient(mainPage, '127.0.0.1', '502', '0')
    await setClientEndianness(mainPage, 'badc')
    await readRegisters(mainPage, '0', '28')
  })

  test('BADC: the registers hold each word byte swapped', async ({ mainPage }) => {
    await expectCell(mainPage, 2, 'hex', 'FEFF')
    await expectCell(mainPage, 3, 'hex', '90EE')
    await expectCell(mainPage, 6, 'hex', '4840')
    await expectCell(mainPage, 7, 'hex', 'C3F5')
  })

  test('BADC: the client reading in BADC shows the values', async ({ mainPage }) => {
    await expectCell(mainPage, 2, 'word_int32', '-70000')
    await expectCellContains(mainPage, 6, 'word_float', '3.14')
  })

  test('BADC: the 16 bit values read as they did', async ({ mainPage }) => {
    await expectCell(mainPage, 0, 'word_int16', '-100')
    await expectCell(mainPage, 1, 'word_uint16', '500')
  })

  test('BADC: the client reading in ABCD shows other values', async ({ mainPage }) => {
    await setClientEndianness(mainPage, 'be')
    await expect(cellLocator(mainPage, 2, 'word_int32')).not.toHaveText('-70000')
    await expect(cellLocator(mainPage, 6, 'word_float')).not.toContainText('3.14')
  })

  test('BADC: the client reading in DCBA shows other values', async ({ mainPage }) => {
    await setClientEndianness(mainPage, 'dcba')
    await expect(cellLocator(mainPage, 2, 'word_int32')).not.toHaveText('-70000')
  })

  test('disconnect before the server changes order', async ({ mainPage }) => {
    await clearData(mainPage)
    await disconnectClient(mainPage)
  })

  // ─── DCBA ──────────────────────────────────────────────────────────

  test('switch server 1 to DCBA', async ({ mainPage }) => {
    await navigateToServer(mainPage)
    await mainPage.getByTestId('select-server-502').click()
    await setServerEndianness(mainPage, 'dcba')
  })

  test('connect the client and read in DCBA', async ({ mainPage }) => {
    await navigateToClient(mainPage)
    await connectClient(mainPage, '127.0.0.1', '502', '0')
    await setClientEndianness(mainPage, 'dcba')
    await readRegisters(mainPage, '0', '28')
  })

  test('DCBA: the registers hold the bytes reversed', async ({ mainPage }) => {
    await expectCell(mainPage, 2, 'hex', '90EE')
    await expectCell(mainPage, 3, 'hex', 'FEFF')
    await expectCell(mainPage, 6, 'hex', 'C3F5')
    await expectCell(mainPage, 7, 'hex', '4840')
  })

  test('DCBA: the client reading in DCBA shows the values', async ({ mainPage }) => {
    await expectCell(mainPage, 2, 'word_int32', '-70000')
    await expectCellContains(mainPage, 6, 'word_float', '3.14')
  })

  test('DCBA: the client reading in CDAB shows other values', async ({ mainPage }) => {
    await setClientEndianness(mainPage, 'le')
    await expect(cellLocator(mainPage, 2, 'word_int32')).not.toHaveText('-70000')
    await expect(cellLocator(mainPage, 6, 'word_float')).not.toContainText('3.14')
  })

  test('DCBA: switching the client back to DCBA reads the values again', async ({ mainPage }) => {
    await setClientEndianness(mainPage, 'dcba')
    await expectCell(mainPage, 2, 'word_int32', '-70000')
  })

  // ─── Cleanup: restore ABCD ─────────────────────────────────────────

  test('restore ABCD on both sides', async ({ mainPage }) => {
    await clearData(mainPage)
    await setClientEndianness(mainPage, 'be')
    await disconnectClient(mainPage)
    await navigateToServer(mainPage)
    await mainPage.getByTestId('select-server-502').click()
    await setServerEndianness(mainPage, 'be')
  })
})
