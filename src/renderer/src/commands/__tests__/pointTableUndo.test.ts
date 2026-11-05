// @vitest-environment happy-dom
//
// `client_apply_point_table` switches read configuration on, and `replaceRegisterMapping`
// switches it off. An undo or a redo replays the mapping, so the step has to carry
// the switch too, or the replayed table is read by the toolbar's 125 registers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientApplyPointTableResult, RegisterMapping } from '@shared'
import { stubRenderer } from '@renderer/context/__tests__/stubRenderer'

vi.mock('notistack', () => ({ enqueueSnackbar: vi.fn() }))

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  stubRenderer()
})

afterEach(async () => {
  const { flushRegisterMappingToMain, useClientZustand } =
    await import('@renderer/context/client.zustand')
  await flushRegisterMappingToMain(useClientZustand.getState().registerMapping)
})

type ClientState = ReturnType<
  typeof import('@renderer/context/client.zustand').useClientZustand.getState
>
type UndoMove = typeof import('@renderer/context/clientUndo').undoClient

const mapping: Partial<RegisterMapping> = {
  holding_registers: { 0: { dataType: 'uint16' }, 200: { dataType: 'uint16' } }
}

const load = async (): Promise<{
  client: () => ClientState
  undoClient: UndoMove
  redoClient: UndoMove
  apply: () => Promise<ClientApplyPointTableResult>
}> => {
  const { useClientZustand } = await import('@renderer/context/client.zustand')
  const { undoClient, redoClient } = await import('@renderer/context/clientUndo')
  const { createPointTableHandlers } = await import('../pointTableHandlers')
  const apply = createPointTableHandlers(() => {}).client_apply_point_table
  return {
    client: () => useClientZustand.getState(),
    undoClient,
    redoClient,
    apply: async () =>
      await apply({
        registerMapping: { ...useClientZustand.getState().registerMapping, ...mapping },
        window: { type: 'holding_registers', address: 0, length: 201 }
      })
  }
}

describe('client_apply_point_table', () => {
  it('turns read configuration back on when redo replays the table', async () => {
    const { client, apply, undoClient, redoClient } = await load()
    expect((await apply()).outcome).toBe('done')
    expect(client().readConfiguration).toBe(true)

    expect(await undoClient()).toBe('done')
    expect(client().readConfiguration).toBe(false)

    expect(await redoClient()).toBe('done')
    expect(client().registerMapping.holding_registers[200]).toBeDefined()
    expect(client().readConfiguration).toBe(true)
  })

  it('keeps read configuration on when undo returns to a table that was already read by its groups', async () => {
    const { client, apply, undoClient } = await load()
    await apply()
    expect(client().readConfiguration).toBe(true)

    // A second table over the first: undoing it returns to the first table.
    const { useClientZustand } = await import('@renderer/context/client.zustand')
    const { createPointTableHandlers } = await import('../pointTableHandlers')
    await createPointTableHandlers(() => {}).client_apply_point_table({
      registerMapping: { ...useClientZustand.getState().registerMapping, ...mapping },
      window: { type: 'holding_registers', address: 0, length: 10 }
    })

    expect(await undoClient()).toBe('done')
    expect(client().readConfiguration).toBe(true)
  })
})
