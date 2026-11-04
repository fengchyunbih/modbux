import { onEvent } from '@renderer/events'

/**
 * Whether the server view is in its own window.
 *
 * The main window's server store hears nothing while the split is up, so what
 * it holds is stale and a project saved or opened from it would be wrong.
 * Main sends `window_update` whenever a window is set, so the flag is right
 * from the first one; the split out window does not track it.
 */
let splitOut = false

if (!window.api.isServerWindow) {
  onEvent('window_update', ({ server }) => {
    splitOut = server
  })
}

export const isServerViewSplitOut = (): boolean => splitOut
