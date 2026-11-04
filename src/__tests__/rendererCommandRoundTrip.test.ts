// @vitest-environment happy-dom
//
// A command from main through the main window's stores and back, with the two
// IPC hops replaced by direct calls: main's `windows.send` delivers to the
// listener `@renderer/commands` installs, and the renderer's `sendEvent` hands
// the reply to `RendererCommands.receive`. Everything between is the real code.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { MAIN_SERVER_UUID } from '@shared'
import { fireEvent, stubRenderer } from '@renderer/context/__tests__/stubRenderer'
import { getDefaultServer } from '@renderer/context/server.zustand.helpers'
import type { Windows } from '../main/windows'
import { RendererCommandError, RendererCommands } from '../main/modules/rendererCommands'

const { enqueueSnackbar } = vi.hoisted(() => ({ enqueueSnackbar: vi.fn() }))
vi.mock('notistack', () => ({ enqueueSnackbar }))

const MAIN = { id: 'main' } as unknown as WebContents

/**
 * Main's half, wired to the renderer the stub stands up.
 *
 * `send` hands the request to the stub's listeners, which is what reaching the
 * main window is, and `stubRenderer`'s `onSend` hands the reply to `receive`.
 */
const wireUp = async ({
  isServerWindow = false
}: { isServerWindow?: boolean } = {}): Promise<RendererCommands> => {
  const windows = {
    main: { isDestroyed: () => false },
    send: (event: string, payload: unknown) => fireEvent(event, payload),
    isMain: (contents: unknown) => contents === MAIN
  } as unknown as Windows
  const commands = new RendererCommands({ windows, timeoutMs: 1000 })
  stubRenderer({
    isServerWindow,
    onSend: (event, reply) => {
      if (event === 'renderer_command_result') commands.receive(MAIN, reply)
    }
  })
  await import('@renderer/commands')
  return commands
}

/** What a rejected command rejected with, or a failure saying it resolved. */
const rejection = async (promise: Promise<unknown>): Promise<RendererCommandError> => {
  try {
    await promise
  } catch (error) {
    if (error instanceof RendererCommandError) return error
    throw error
  }
  throw new Error('the command resolved')
}

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
})

describe('a command from main to the main window and back', () => {
  it('answers client_get_config from the client store', async () => {
    const commands = await wireUp()
    const { useClientZustand } = await import('@renderer/context/client.zustand')
    useClientZustand.setState((state) => {
      state.name = 'Meter on the bench'
      state.connectionConfig.unitId = 7
      state.registerMapping.holding_registers[40] = { dataType: 'float', scalingFactor: 0.1 }
    })

    const config = await commands.send('client_get_config')

    expect(config.name).toBe('Meter on the bench')
    expect(config.connectionConfig.unitId).toBe(7)
    expect(config.registerMapping.holding_registers[40]).toEqual({
      dataType: 'float',
      scalingFactor: 0.1
    })
    expect(config.registerConfig).toEqual(useClientZustand.getState().registerConfig)
  })

  it('answers server_list from the server store, in the order it holds them', async () => {
    const commands = await wireUp()
    const { useServerZustand } = await import('@renderer/context/server.zustand')
    useServerZustand.setState({
      selectedUuid: 'second',
      servers: {
        [MAIN_SERVER_UUID]: { ...getDefaultServer(), port: '502' },
        second: { ...getDefaultServer(), port: '503', unitId: '4', name: 'Inverter' }
      }
    })

    expect(await commands.send('server_list')).toEqual({
      selectedUuid: 'second',
      servers: [
        { uuid: MAIN_SERVER_UUID, name: undefined, port: '502', unitId: '0' },
        { uuid: 'second', name: 'Inverter', port: '503', unitId: '4' }
      ]
    })
  })

  // While the split is up the main window's copy of the server store hears
  // none of the events that change it, so an answer from it would be stale.
  it('refuses server_list while the server view is split out, and answers once it is back', async () => {
    const commands = await wireUp()

    fireEvent('window_update', { main: true, server: true })
    const error = await rejection(commands.send('server_list'))
    expect(error.code).toBe('failed')
    expect(error.message).toBe(
      'server_list: The server view is in its own window; close it to use server commands'
    )

    fireEvent('window_update', { main: true, server: false })
    expect((await commands.send('server_list')).servers.length).toBeGreaterThan(0)
  })

  it('answers client_get_config while the server view is split out', async () => {
    const commands = await wireUp()

    fireEvent('window_update', { main: true, server: true })

    expect((await commands.send('client_get_config')).name).toEqual(expect.any(String))
  })

  // Main addresses commands to the main window alone, and the split out
  // window loading the same bundle must not answer one that reaches it.
  it('leaves a command to the split out server window unanswered', async () => {
    vi.useFakeTimers()
    try {
      const commands = await wireUp({ isServerWindow: true })

      const settled = rejection(commands.send('server_list'))
      await vi.advanceTimersByTimeAsync(1000)

      expect((await settled).code).toBe('timeout')
    } finally {
      vi.useRealTimers()
    }
  })
})
