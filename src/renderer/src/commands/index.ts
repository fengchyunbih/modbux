import { onEvent, sendEvent } from '@renderer/events'
import { dispatchRendererCommand } from './dispatchRendererCommand'
import { createRendererCommandHandlers } from './rendererCommandHandlers'

/**
 * The main window answers the commands main sends it; the split out server
 * window installs nothing. Main addresses `renderer_command` to the main window
 * alone, and `RendererCommands.receive` drops a reply from any other.
 */
if (!window.api.isServerWindow) {
  let serverViewSplitOut = false
  onEvent('window_update', ({ server }) => {
    serverViewSplitOut = server
  })

  const handlers = createRendererCommandHandlers({ serverViewSplitOut: () => serverViewSplitOut })

  onEvent('renderer_command', (request) => {
    void dispatchRendererCommand(request, handlers).then((reply) => {
      if (reply) sendEvent('renderer_command_result', reply)
    })
  })
}
