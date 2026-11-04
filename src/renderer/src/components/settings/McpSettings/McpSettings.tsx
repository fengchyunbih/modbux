import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import FormControlLabel from '@mui/material/FormControlLabel'
import Paper from '@mui/material/Paper'
import Switch from '@mui/material/Switch'
import Typography from '@mui/material/Typography'
import CommandBlock from '@renderer/components/shared/CommandBlock'
import { meme } from '@renderer/components/shared/inputs/meme'
import { claudeCodeMcpCommand, McpRunState } from '@shared'
import { ChangeEvent, useCallback, useEffect, useState } from 'react'
import { useMcpSettingsZustand } from './mcpSettings.zustand'

/**
 * The MCP server's settings: the two switches, what the server is doing, and
 * what an MCP client is configured with.
 *
 * Main owns the settings and answers every change with the status it ends in,
 * so each handler writes that answer into the store and nothing else.
 */

const STATE_LABELS: Record<McpRunState, string> = {
  stopped: 'Stopped',
  running: 'Running',
  error: 'Error'
}

const STATE_COLORS: Record<McpRunState, 'default' | 'success' | 'error'> = {
  stopped: 'default',
  running: 'success',
  error: 'error'
}

//
//
// Enable MCP
const EnableSwitch = meme((): JSX.Element => {
  const enabled = useMcpSettingsZustand((z) => z.status?.enabled ?? false)
  const known = useMcpSettingsZustand((z) => z.status !== undefined)
  // The listener takes a moment to start or stop, and a second flip in that
  // moment would be queued behind the first.
  const [busy, setBusy] = useState(false)

  const handleChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    setBusy(true)
    try {
      const status = await window.api.setMcpEnabled(event.target.checked)
      useMcpSettingsZustand.getState().setStatus(status)
    } finally {
      setBusy(false)
    }
  }, [])

  return (
    <FormControlLabel
      control={
        <Switch
          data-testid="mcp-enabled-switch"
          checked={enabled}
          disabled={!known || busy}
          onChange={handleChange}
        />
      }
      label="Enable MCP"
    />
  )
})

//
//
// Allow writes to devices
const AllowWritesSwitch = meme((): JSX.Element => {
  const allowWrites = useMcpSettingsZustand((z) => z.status?.allowWrites ?? false)
  const known = useMcpSettingsZustand((z) => z.status !== undefined)

  const handleChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const status = await window.api.setMcpAllowWrites(event.target.checked)
    useMcpSettingsZustand.getState().setStatus(status)
  }, [])

  return (
    <Box>
      <FormControlLabel
        control={
          <Switch
            data-testid="mcp-allow-writes-switch"
            checked={allowWrites}
            disabled={!known}
            onChange={handleChange}
          />
        }
        label="Allow writes to devices"
      />
      <Typography variant="body2" color="text.secondary" sx={{ ml: 6 }}>
        Off: every MCP tool that writes to a device is refused. Reading and connecting stay allowed.
      </Typography>
    </Box>
  )
})

//
//
// What the server is doing
const Status = meme((): JSX.Element => {
  const state = useMcpSettingsZustand((z) => z.status?.state ?? 'stopped')
  const error = useMcpSettingsZustand((z) => z.status?.error)

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="body2">Status</Typography>
        <Chip
          data-testid="mcp-status"
          data-state={state}
          size="small"
          label={STATE_LABELS[state]}
          color={STATE_COLORS[state]}
        />
      </Box>
      {error !== undefined && (
        <Alert severity="error" data-testid="mcp-status-error">
          {error}
        </Alert>
      )}
    </Box>
  )
})

//
//
// The token, and the button that replaces it
const RegenerateTokenButton = meme((): JSX.Element => {
  const known = useMcpSettingsZustand((z) => z.status !== undefined)

  const handleClick = useCallback(async () => {
    const status = await window.api.regenerateMcpToken()
    useMcpSettingsZustand.getState().setStatus(status)
  }, [])

  return (
    <Button
      data-testid="mcp-regenerate-token-btn"
      variant="outlined"
      size="small"
      disabled={!known}
      onClick={handleClick}
    >
      Regenerate token
    </Button>
  )
})

/** One labelled value with a copy button. */
const Field = meme(
  ({ label, value, testId }: { label: string; value: string; testId: string }): JSX.Element => (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <CommandBlock command={value} testId={testId} />
    </Box>
  )
)

/** The stdio shim, for an MCP client that cannot speak HTTP. It finds the token itself. */
const StdioCommands = meme((): JSX.Element | null => {
  const command = useMcpSettingsZustand((z) => z.status?.stdio?.command)
  const claudeCodeCommand = useMcpSettingsZustand((z) => z.status?.stdio?.claudeCodeCommand)
  if (command === undefined || claudeCodeCommand === undefined) return null

  return (
    <>
      <Field
        label="Claude Code over stdio: run this once instead of the command above"
        value={claudeCodeCommand}
        testId="mcp-stdio-claude-command"
      />
      <Field
        label="Any client that starts a stdio server: this command. It reads the token from mcp.json, or from MODBUX_MCP_TOKEN."
        value={command}
        testId="mcp-stdio-command"
      />
    </>
  )
})

const Connection = meme((): JSX.Element => {
  const url = useMcpSettingsZustand((z) => z.status?.url ?? '')
  const token = useMcpSettingsZustand((z) => z.status?.token ?? '')

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Field label="URL" value={url} testId="mcp-url" />
      <Field label="Bearer token" value={token} testId="mcp-token" />
      <Box>
        <RegenerateTokenButton />
      </Box>
      <Field
        label="Claude Code: run this once to add Modbux"
        value={claudeCodeMcpCommand(token)}
        testId="mcp-claude-command"
      />
      <StdioCommands />
      <Typography variant="body2" color="text.secondary">
        Any other MCP client: Streamable HTTP transport, the URL above, and the header
        Authorization: Bearer followed by the token. MCP works only while this window is open.
      </Typography>
    </Box>
  )
})

//
//
// MAIN
const McpSettings = meme((): JSX.Element => {
  // `mcp_status` is pushed on a change, so the page asks once for where things stand.
  useEffect(() => {
    window.api
      .getMcpStatus()
      .then((status) => useMcpSettingsZustand.getState().setStatus(status))
      .catch((error) => console.error('The MCP status was not read:', error))
  }, [])

  return (
    <Paper
      data-testid="mcp-settings"
      variant="outlined"
      sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 760 }}
    >
      <Typography variant="h6">MCP server</Typography>
      <Typography variant="body2" color="text.secondary">
        Lets an AI agent on this computer use the Modbux client through the Model Context Protocol.
        The server listens on 127.0.0.1 only and refuses every request without the token.
      </Typography>
      <EnableSwitch />
      <AllowWritesSwitch />
      <Status />
      <Connection />
    </Paper>
  )
})

export default McpSettings
