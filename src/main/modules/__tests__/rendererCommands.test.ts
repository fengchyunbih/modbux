import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { WebContents } from 'electron'
import type { RendererCommandRequest } from '@shared'
import type { Windows } from '../../windows'
import { RendererCommandError, RendererCommands } from '../rendererCommands'

/** Stands in for the main window's `WebContents`, which `isMain` answers true for. */
const MAIN = { id: 'main' } as unknown as WebContents
const SERVER = { id: 'server' } as unknown as WebContents

const serverList = {
  selectedUuid: 'a',
  servers: [{ uuid: 'a', name: 'Meter', port: '502', unitId: '1' }]
}

interface FakeWindows {
  windows: Windows
  /** Every `renderer_command` sent, with whom it was addressed to. */
  requests: Array<{ request: RendererCommandRequest; to: unknown }>
  setMain: (main: { isDestroyed: () => boolean } | null) => void
}

const createWindows = (): FakeWindows => {
  const requests: FakeWindows['requests'] = []
  let main: { isDestroyed: () => boolean } | null = { isDestroyed: () => false }
  const windows = {
    get main(): { isDestroyed: () => boolean } | null {
      return main
    },
    send: (event: string, request: RendererCommandRequest, to: unknown) => {
      if (event === 'renderer_command') requests.push({ request, to })
    },
    isMain: (contents: unknown) => contents === MAIN
  } as unknown as Windows
  return { windows, requests, setMain: (next) => (main = next) }
}

/** The request sent nth, or a failure naming the one that never went out. */
const requestAt = (fake: FakeWindows, index: number): RendererCommandRequest => {
  const sent = fake.requests[index]
  if (!sent) throw new Error(`no renderer_command was sent at index ${index}`)
  return sent.request
}

/** What a rejected promise rejected with, or a failure saying it resolved. */
const rejection = async (promise: Promise<unknown>): Promise<RendererCommandError> => {
  try {
    await promise
  } catch (error) {
    if (error instanceof RendererCommandError) return error
    throw error
  }
  throw new Error('the command resolved')
}

describe('RendererCommands', () => {
  let fake: FakeWindows
  let commands: RendererCommands
  let nextId = 0

  beforeEach(() => {
    vi.useFakeTimers()
    nextId = 0
    fake = createWindows()
    commands = new RendererCommands({
      windows: fake.windows,
      timeoutMs: 1000,
      createId: (): string => `id-${++nextId}`
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends the request to the main window alone', () => {
    void commands.send('server_list')

    expect(fake.requests).toEqual([
      { request: { id: 'id-1', name: 'server_list', payload: undefined }, to: 'main' }
    ])
  })

  it('resolves with the result the main window answered', async () => {
    const pending = commands.send('server_list')

    commands.receive(MAIN, { id: requestAt(fake, 0).id, ok: true, result: serverList })

    await expect(pending).resolves.toEqual(serverList)
    expect(commands.pendingCount).toBe(0)
  })

  // Two commands in flight are answered in whatever order the renderer
  // finishes them, and each caller has to get its own.
  it('matches each reply to its own command by id', async () => {
    const first = commands.send('server_list')
    const second = commands.send('server_list')
    const other = { selectedUuid: 'b', servers: [] }

    commands.receive(MAIN, { id: requestAt(fake, 1).id, ok: true, result: other })
    commands.receive(MAIN, { id: requestAt(fake, 0).id, ok: true, result: serverList })

    await expect(first).resolves.toEqual(serverList)
    await expect(second).resolves.toEqual(other)
  })

  it('rejects with the error the main window answered', async () => {
    const pending = commands.send('server_list')

    commands.receive(MAIN, { id: requestAt(fake, 0).id, ok: false, error: 'it broke' })

    const error = await rejection(pending)
    expect(error.code).toBe('failed')
    expect(error.message).toBe('server_list: it broke')
  })

  it('rejects a result its schema refuses', async () => {
    const pending = commands.send('server_list')

    commands.receive(MAIN, { id: requestAt(fake, 0).id, ok: true, result: { servers: 'none' } })

    expect((await rejection(pending)).code).toBe('invalid_result')
  })

  it('fails at once, sending nothing, when no main window is open', async () => {
    fake.setMain(null)

    const error = await rejection(commands.send('server_list'))

    expect(error.code).toBe('no_main_window')
    expect(error.message).toBe('server_list: the main window is not open')
    expect(fake.requests).toEqual([])
  })

  it('fails at once when the main window handle is destroyed', async () => {
    fake.setMain({ isDestroyed: () => true })

    expect((await rejection(commands.send('client_get_config'))).code).toBe('no_main_window')
    expect(fake.requests).toEqual([])
  })

  it('rejects when nothing answers within the timeout', async () => {
    const pending = commands.send('server_list')
    const settled = rejection(pending)

    await vi.advanceTimersByTimeAsync(999)
    expect(commands.pendingCount).toBe(1)
    await vi.advanceTimersByTimeAsync(1)

    const error = await settled
    expect(error.code).toBe('timeout')
    expect(error.message).toBe('server_list: the main window did not answer within 1000 ms')
    expect(commands.pendingCount).toBe(0)
  })

  it('clears the timeout of a command that was answered', async () => {
    const pending = commands.send('server_list')
    expect(vi.getTimerCount()).toBe(1)

    commands.receive(MAIN, { id: requestAt(fake, 0).id, ok: true, result: serverList })

    await expect(pending).resolves.toEqual(serverList)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('drops a reply that comes after the timeout', async () => {
    const settled = rejection(commands.send('server_list'))
    await vi.advanceTimersByTimeAsync(1000)

    commands.receive(MAIN, { id: requestAt(fake, 0).id, ok: true, result: serverList })

    expect((await settled).code).toBe('timeout')
  })

  // The split out window loads the same renderer, so a reply with the right id
  // from it would be an answer from a store that was not asked.
  it('drops a reply from any window but the main one', async () => {
    const pending = commands.send('server_list')
    const id = requestAt(fake, 0).id

    commands.receive(SERVER, { id, ok: true, result: { selectedUuid: 'x', servers: [] } })
    expect(commands.pendingCount).toBe(1)
    commands.receive(MAIN, { id, ok: true, result: serverList })

    await expect(pending).resolves.toEqual(serverList)
  })

  it('drops a reply that is not one', async () => {
    const pending = commands.send('server_list')
    const id = requestAt(fake, 0).id

    commands.receive(MAIN, { id, result: serverList })
    commands.receive(MAIN, undefined)
    expect(commands.pendingCount).toBe(1)
    commands.receive(MAIN, { id, ok: true, result: serverList })

    await expect(pending).resolves.toEqual(serverList)
  })

  it('rejects every waiting command when the main window closes', async () => {
    const first = rejection(commands.send('server_list'))
    const second = rejection(commands.send('client_get_config'))

    commands.abandonAll()

    expect((await first).code).toBe('window_closed')
    expect((await second).code).toBe('window_closed')
    expect(commands.pendingCount).toBe(0)
  })
})
