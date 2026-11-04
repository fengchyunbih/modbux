/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RegisterData } from '@shared'
import { MAIN_WINDOW_CLOSED } from '../registry'
import {
  MAX_FOUND_ROWS,
  MAX_SCAN_ADDRESSES,
  MAX_SCAN_UNIT_REQUESTS,
  SCAN_DEADLINE_MS,
  scanTools
} from '../tools/scan'
import { connectInMemory, fakeContext, jsonOf, textOf } from './fakeContext'

const tool = (name: string) => {
  const found = scanTools.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`no tool ${name}`)
  return found
}

const row = (id: number, word: number): RegisterData =>
  ({
    id,
    hex: word.toString(16).padStart(4, '0'),
    words: { uint16: word }
  }) as unknown as RegisterData

const connected = () => {
  const context = fakeContext()
  context.setClientState({ connectState: 'connected' })
  return context
}

describe('the scan tools in the tool list', () => {
  it('are read only and open world', async () => {
    const client = await connectInMemory(fakeContext())

    const { tools } = await client.listTools()

    const scans = tools.filter((candidate) => candidate.name.startsWith('client_scan_'))
    expect(scans.map((candidate) => candidate.name)).toEqual([
      'client_scan_registers',
      'client_scan_unit_ids'
    ])
    for (const scan of scans) {
      expect(scan.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true })
    }
  })
})

describe('client_scan_registers', () => {
  it('scans the range through the client and answers the found addresses sorted', async () => {
    const context = connected()
    context.scanRegisters.mockResolvedValue({
      scanned: true,
      stopped: false,
      found: [row(12, 0x00ff), row(10, 0x1234)],
      errors: []
    })

    const result = jsonOf(
      await tool('client_scan_registers').call(
        { registerType: 'input_registers', startAddress: 10, count: 5 },
        context
      )
    )

    expect(context.scanRegisters).toHaveBeenCalledWith({
      addressRange: [10, 14],
      length: 5,
      timeout: 500,
      registerType: 'input_registers'
    })
    expect(result).toMatchObject({
      unitId: 7,
      registerType: 'input_registers',
      range: [10, 14],
      foundCount: 2,
      found: [
        { address: 10, word: 0x1234, hex: '1234' },
        { address: 12, word: 0xff, hex: '00ff' }
      ],
      truncated: false,
      stopped: false
    })
  })

  it('asks no more than the range and drops rows past its end', async () => {
    const context = connected()
    context.scanRegisters.mockResolvedValue({
      scanned: true,
      stopped: false,
      found: [row(4, 1), row(5, 2), row(6, 3)],
      errors: []
    })

    const result = jsonOf(
      await tool('client_scan_registers').call(
        { registerType: 'holding_registers', startAddress: 0, count: 5, chunkSize: 100 },
        context
      )
    )

    expect(context.scanRegisters).toHaveBeenCalledWith(expect.objectContaining({ length: 5 }))
    expect((result.found as { address: number }[]).map((r) => r.address)).toEqual([4])
    expect(result.foundCount).toBe(1)
  })

  it('answers bits for a coil scan, and the client register type without registerType', async () => {
    const context = connected()
    context.scanRegisters.mockResolvedValue({
      scanned: true,
      stopped: false,
      found: [{ id: 3, bit: true } as RegisterData],
      errors: []
    })

    const result = jsonOf(
      await tool('client_scan_registers').call(
        { registerType: 'coils', startAddress: 0, count: 8 },
        context
      )
    )
    expect(result.found).toEqual([{ address: 3, bit: true }])

    await tool('client_scan_registers').call({ startAddress: 0, count: 8 }, context)
    expect(context.scanRegisters).toHaveBeenLastCalledWith(
      expect.objectContaining({ registerType: undefined })
    )
    expect(
      jsonOf(await tool('client_scan_registers').call({ startAddress: 0, count: 8 }, context))
    ).toMatchObject({ registerType: context.appState.registerConfig.type })
  })

  it('refuses a range past the last address or past the limit, before any request', async () => {
    const context = connected()

    const past = await tool('client_scan_registers').call(
      { startAddress: 65530, count: 10 },
      context
    )
    const over = await tool('client_scan_registers').call(
      { startAddress: 0, count: MAX_SCAN_ADDRESSES + 1 },
      context
    )

    expect(past.isError).toBe(true)
    expect(textOf(past)).toContain('65535')
    expect(over.isError).toBe(true)
    expect(textOf(over)).toContain('Invalid arguments')
    expect(context.scanRegisters).not.toHaveBeenCalled()
  })

  it('refuses a timeout outside its bounds', async () => {
    const context = connected()

    const result = await tool('client_scan_registers').call(
      { startAddress: 0, count: 10, timeoutMs: 60000 },
      context
    )

    expect(result.isError).toBe(true)
    expect(context.scanRegisters).not.toHaveBeenCalled()
  })

  it('refuses while disconnected', async () => {
    const context = fakeContext()

    const result = await tool('client_scan_registers').call({ startAddress: 0, count: 10 }, context)

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('client_connect')
    expect(context.scanRegisters).not.toHaveBeenCalled()
  })

  it.each([
    ['polling', 'a poll'],
    ['scanningUnitIds', 'a unit id scan'],
    ['scanningRegisters', 'a register scan'],
    ['reading', 'another read'],
    ['writing', 'another write']
  ] as const)('refuses while %s', async (flag, owner) => {
    const context = connected()
    context.setClientState({ [flag]: true })

    const result = await tool('client_scan_registers').call({ startAddress: 0, count: 10 }, context)

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain(`Cannot scan during ${owner}`)
    expect(context.scanRegisters).not.toHaveBeenCalled()
  })

  it('refuses when the client says it is busy', async () => {
    const context = connected()
    context.scanRegisters.mockResolvedValue({ scanned: false, reason: 'busy' })

    const result = await tool('client_scan_registers').call({ startAddress: 0, count: 10 }, context)

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('busy')
  })

  it('refuses when the main window is closed', async () => {
    const context = connected()
    context.setMainWindowOpen(false)

    const result = await tool('client_scan_registers').call({ startAddress: 0, count: 10 }, context)

    expect(textOf(result)).toBe(MAIN_WINDOW_CLOSED)
  })

  it('caps the rows it answers and says so', async () => {
    const context = connected()
    const found = Array.from({ length: MAX_FOUND_ROWS + 5 }, (_, i) => row(i, 1))
    context.scanRegisters.mockResolvedValue({ scanned: true, stopped: false, found, errors: [] })

    const result = jsonOf(
      await tool('client_scan_registers').call({ startAddress: 0, count: 5000 }, context)
    )

    expect(result.foundCount).toBe(MAX_FOUND_ROWS + 5)
    expect((result.found as unknown[]).length).toBe(MAX_FOUND_ROWS)
    expect(result.truncated).toBe(true)
  })

  describe('the deadline', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('stops the scan and answers what it has', async () => {
      const context = connected()
      context.scanRegisters.mockImplementation(
        () =>
          new Promise((resolve) => {
            context.stopScanningRegisters.mockImplementation(() =>
              resolve({ scanned: true, stopped: true, found: [row(1, 9)], errors: [] })
            )
          })
      )

      const pending = tool('client_scan_registers').call({ startAddress: 0, count: 10000 }, context)
      await vi.advanceTimersByTimeAsync(SCAN_DEADLINE_MS - 1)
      expect(context.stopScanningRegisters).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      const result = jsonOf(await pending)

      expect(context.stopScanningRegisters).toHaveBeenCalledTimes(1)
      expect(result).toMatchObject({ stopped: true, foundCount: 1 })
      expect(result.stoppedBy).toContain('deadline')
    })

    it('does not stop a scan that finished in time', async () => {
      const context = connected()

      await tool('client_scan_registers').call({ startAddress: 0, count: 10 }, context)
      await vi.advanceTimersByTimeAsync(SCAN_DEADLINE_MS * 2)

      expect(context.stopScanningRegisters).not.toHaveBeenCalled()
    })
  })
})

describe('client_scan_unit_ids', () => {
  it('asks the range and answers the units that replied', async () => {
    const context = connected()
    const none = { coils: '', discrete_inputs: '', input_registers: '', holding_registers: '' }
    context.scanUnitIds.mockResolvedValue({
      scanned: true,
      stopped: false,
      results: [
        {
          id: 1,
          registerTypes: [],
          refusedRegisterTypes: [],
          requestedRegisterTypes: ['holding_registers'],
          errorMessage: none
        },
        {
          id: 2,
          registerTypes: ['holding_registers'],
          refusedRegisterTypes: [],
          requestedRegisterTypes: ['holding_registers'],
          errorMessage: none
        },
        {
          id: 3,
          registerTypes: [],
          refusedRegisterTypes: ['holding_registers'],
          requestedRegisterTypes: ['holding_registers'],
          errorMessage: none
        }
      ]
    })

    const result = jsonOf(
      await tool('client_scan_unit_ids').call({ startUnitId: 1, endUnitId: 3 }, context)
    )

    expect(context.scanUnitIds).toHaveBeenCalledWith({
      range: [1, 3],
      address: 0,
      length: 1,
      registerTypes: ['holding_registers'],
      timeout: 500
    })
    expect(result).toMatchObject({
      unitsAsked: 3,
      replied: [
        { unitId: 2, answeredWithData: ['holding_registers'], answeredWithException: [] },
        { unitId: 3, answeredWithData: [], answeredWithException: ['holding_registers'] }
      ],
      stopped: false
    })
  })

  it('refuses a reversed range and one over the request limit', async () => {
    const context = connected()

    const reversed = await tool('client_scan_unit_ids').call(
      { startUnitId: 5, endUnitId: 1 },
      context
    )
    const over = await tool('client_scan_unit_ids').call(
      {
        startUnitId: 0,
        endUnitId: 255,
        registerTypes: ['coils', 'discrete_inputs', 'holding_registers', 'input_registers']
      },
      context
    )

    expect(reversed.isError).toBe(true)
    expect(over.isError).toBe(true)
    expect(textOf(over)).toContain(String(MAX_SCAN_UNIT_REQUESTS))
    expect(context.scanUnitIds).not.toHaveBeenCalled()
  })

  it('refuses a length one read of the register types cannot carry', async () => {
    const context = connected()

    const result = await tool('client_scan_unit_ids').call(
      { startUnitId: 1, endUnitId: 2, length: 126 },
      context
    )

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('125')
    expect(context.scanUnitIds).not.toHaveBeenCalled()
  })

  it('refuses while a poll runs, and while disconnected', async () => {
    const polling = connected()
    polling.setClientState({ polling: true })
    const disconnected = fakeContext()

    const busy = await tool('client_scan_unit_ids').call({ startUnitId: 1, endUnitId: 2 }, polling)
    const notConnected = await tool('client_scan_unit_ids').call(
      { startUnitId: 1, endUnitId: 2 },
      disconnected
    )

    expect(textOf(busy)).toContain('Cannot scan during a poll')
    expect(textOf(notConnected)).toContain('client_connect')
    expect(polling.scanUnitIds).not.toHaveBeenCalled()
    expect(disconnected.scanUnitIds).not.toHaveBeenCalled()
  })
})
