import { describe, it, expect, vi } from 'vitest'
import {
  ClientConfigSnapshot,
  defaultConnectionConfig,
  defaultRegisterConfig,
  emptyRegisterMapping
} from '@shared'
import { dispatchRendererCommand, RendererCommandHandlers } from '../dispatchRendererCommand'

const config: ClientConfigSnapshot = {
  name: 'Meter',
  connectionConfig: defaultConnectionConfig,
  registerConfig: defaultRegisterConfig,
  registerMapping: emptyRegisterMapping(),
  readConfiguration: false
}

const handlersAnswering = (): RendererCommandHandlers => ({
  client_get_config: vi.fn(() => config),
  server_list: vi.fn(async () => ({ selectedUuid: 'a', servers: [] }))
})

describe('dispatchRendererCommand', () => {
  it('answers the result of the handler the name picks', async () => {
    const handlers = handlersAnswering()

    const reply = await dispatchRendererCommand(
      { id: 'one', name: 'server_list', payload: undefined },
      handlers
    )

    expect(reply).toEqual({ id: 'one', ok: true, result: { selectedUuid: 'a', servers: [] } })
    expect(handlers.client_get_config).not.toHaveBeenCalled()
  })

  it('answers the other command with its own handler', async () => {
    const reply = await dispatchRendererCommand(
      { id: 'two', name: 'client_get_config' },
      handlersAnswering()
    )

    expect(reply).toEqual({ id: 'two', ok: true, result: config })
  })

  it('answers an error for a name that is no command', async () => {
    const reply = await dispatchRendererCommand(
      { id: 'three', name: 'client_delete_everything', payload: undefined },
      handlersAnswering()
    )

    expect(reply).toEqual({
      id: 'three',
      ok: false,
      error: 'Unknown command: client_delete_everything'
    })
  })

  // `hasOwnProperty` and not `in`, or a request naming one of Object's own
  // keys would reach `handlers[name]` and call something that is no handler.
  it('answers an error for a name off the prototype', async () => {
    const reply = await dispatchRendererCommand(
      { id: 'four', name: 'toString', payload: undefined },
      handlersAnswering()
    )

    expect(reply).toEqual({ id: 'four', ok: false, error: 'Unknown command: toString' })
  })

  it('answers an error, and never runs the handler, for a payload the schema refuses', async () => {
    const handlers = handlersAnswering()

    const reply = await dispatchRendererCommand(
      { id: 'five', name: 'server_list', payload: { uuid: 'a' } },
      handlers
    )

    expect(reply?.ok).toBe(false)
    expect(reply && !reply.ok && reply.error.startsWith('Invalid payload for server_list:')).toBe(
      true
    )
    expect(handlers.server_list).not.toHaveBeenCalled()
  })

  it('answers the message of a handler that throws', async () => {
    const handlers = {
      ...handlersAnswering(),
      server_list: (): never => {
        throw new Error('The server view is in its own window')
      }
    }

    expect(await dispatchRendererCommand({ id: 'six', name: 'server_list' }, handlers)).toEqual({
      id: 'six',
      ok: false,
      error: 'The server view is in its own window'
    })
  })

  it('answers the message of a handler that rejects', async () => {
    const handlers = {
      ...handlersAnswering(),
      server_list: (): Promise<never> => Promise.reject(new Error('main refused it'))
    }

    expect(await dispatchRendererCommand({ id: 'seven', name: 'server_list' }, handlers)).toEqual({
      id: 'seven',
      ok: false,
      error: 'main refused it'
    })
  })

  it('answers what was thrown when it is not an Error', async () => {
    const handlers = {
      ...handlersAnswering(),
      server_list: (): Promise<never> => Promise.reject('plain text')
    }

    expect(await dispatchRendererCommand({ id: 'eight', name: 'server_list' }, handlers)).toEqual({
      id: 'eight',
      ok: false,
      error: 'plain text'
    })
  })

  it.each([undefined, 'server_list', { name: 'server_list' }, { id: '', name: 'server_list' }])(
    'answers nobody for a request with no id to answer to: %j',
    async (request) => {
      expect(await dispatchRendererCommand(request, handlersAnswering())).toBe(undefined)
    }
  )
})
