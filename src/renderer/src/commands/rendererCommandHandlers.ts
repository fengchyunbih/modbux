import { useClientZustand } from '@renderer/context/client.zustand'
import { useServerZustand } from '@renderer/context/server.zustand'
import { ClientConfigSnapshot, ServerList } from '@shared'
import { connectClient, disconnectClient } from '@renderer/context/clientConnection'
import { createConfigFileCommandHandlers } from './configFileCommandHandlers'
import { RendererCommandHandlers } from './dispatchRendererCommand'
import { createPointTableHandlers } from './pointTableHandlers'

interface HandlerContext {
  /**
   * Whether the server view is in the split out window right now.
   *
   * While it is, that window's server store is the one written, and this
   * window's copy hears none of the events that change it
   * (`server.zustand.ts`, the `window_update` listener).
   */
  serverViewSplitOut: () => boolean
}

const SPLIT_OUT = 'The server view is in its own window; close it to use server commands'

/**
 * The commands the main window answers, each one read from or run by the store
 * that owns what it is about.
 */
export const createRendererCommandHandlers = ({
  serverViewSplitOut
}: HandlerContext): RendererCommandHandlers => ({
  ...createPointTableHandlers(() => {
    if (serverViewSplitOut()) throw new Error(SPLIT_OUT)
  }),

  client_get_config: (): ClientConfigSnapshot => {
    const { name, connectionConfig, registerConfig, registerMapping, readConfiguration } =
      useClientZustand.getState()
    return { name, connectionConfig, registerConfig, registerMapping, readConfiguration }
  },

  client_connect: connectClient,
  client_disconnect: disconnectClient,

  ...createConfigFileCommandHandlers({ serverViewSplitOut }),

  server_list: (): ServerList => {
    if (serverViewSplitOut()) throw new Error(SPLIT_OUT)
    const { servers, selectedUuid } = useServerZustand.getState()
    return {
      selectedUuid,
      servers: Object.entries(servers).map(([uuid, { name, port, unitId }]) => ({
        uuid,
        name,
        port,
        unitId
      }))
    }
  }
})
