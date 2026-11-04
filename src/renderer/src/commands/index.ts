import { onEvent, sendEvent } from '@renderer/events'
import { createSerialRunner, dispatchRendererCommand } from './dispatchRendererCommand'
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

  // One at a time, in the order main sent them. A command main has given up
  // on still runs to its end, which is why its timeout says to check.
  const runInOrder = createSerialRunner()
  onEvent('renderer_command', (request) => {
    void runInOrder(async () => {
      const reply = await dispatchRendererCommand(request, handlers)
      if (reply) sendEvent('renderer_command_result', reply)
    })
  })
}
