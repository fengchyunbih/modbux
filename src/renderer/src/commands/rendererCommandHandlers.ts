import { useClientZustand } from '@renderer/context/client.zustand'
import { useServerZustand } from '@renderer/context/server.zustand'
import { ClientConfigSnapshot, ServerList } from '@shared'
import { RendererCommandHandlers } from './dispatchRendererCommand'

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

/**
 * The commands the main window answers, each one read from or run by the store
 * that owns what it is about.
 */
export const createRendererCommandHandlers = ({
  serverViewSplitOut
}: HandlerContext): RendererCommandHandlers => ({
  client_get_config: (): ClientConfigSnapshot => {
    const { name, connectionConfig, registerConfig, registerMapping, readConfiguration } =
      useClientZustand.getState()
    return { name, connectionConfig, registerConfig, registerMapping, readConfiguration }
  },

  server_list: (): ServerList => {
    if (serverViewSplitOut()) {
      throw new Error('The server view is in its own window; close it to use server commands')
    }
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
