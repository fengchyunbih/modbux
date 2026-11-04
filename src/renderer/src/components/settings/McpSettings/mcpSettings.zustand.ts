/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { McpStatus } from '@shared'
import { create } from 'zustand'
import { mutative } from 'zustand-mutative'
import { onEvent } from '@renderer/events'

interface McpSettingsZustand {
  /** What main last said about the MCP server, or nothing before it has answered. */
  status: McpStatus | undefined
  setStatus: (status: McpStatus) => void
}

export const useMcpSettingsZustand = create<McpSettingsZustand, [['zustand/mutative', never]]>(
  mutative((set) => ({
    status: undefined,
    setStatus: (status) =>
      set((state) => {
        state.status = status
      })
  }))
)

// Main pushes the status on every change, which includes the startup listen
// that `index.ts` does not wait for: a window open before it fails hears it here.
onEvent('mcp_status', (status) => useMcpSettingsZustand.getState().setStatus(status))
