import Delete from '@mui/icons-material/Delete'
import FileOpen from '@mui/icons-material/FileOpen'
import Save from '@mui/icons-material/Save'
import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import { downloadJson } from '@renderer/components/shared/downloadJson'
import { meme } from '@renderer/components/shared/inputs/meme'
import { useServerZustand } from '@renderer/context/server.zustand'
import { asOneServerStep } from '@renderer/context/serverUndo'
import { exportServerConfig, importServerConfig } from '@renderer/context/serverConfigFile'
import { resetMessage } from '@shared'
import { snakeCase } from 'lodash'
import { useSnackbar } from 'notistack'
import { useRef, useState, useCallback } from 'react'

//
//
// Open button
type UseOpenHook = () => {
  opening: boolean
  openingRef: React.MutableRefObject<boolean>
  open: (file: File | undefined) => Promise<void>
}

const useOpen: UseOpenHook = () => {
  const openingRef = useRef(false)
  const [opening, setOpening] = useState(false)

  const { enqueueSnackbar } = useSnackbar()

  const open = useCallback(
    async (file: File | undefined) => {
      if (!file) return
      if (openingRef.current) return
      openingRef.current = true
      setOpening(true)

      try {
        const outcome = await importServerConfig(await file.text())
        if (!outcome.ok) {
          enqueueSnackbar({ variant: 'error', message: `Failed to load config: ${outcome.error}` })
          return
        }
        const { config, migrated, wasMixedEndianness, futureVersion } = outcome

        if (migrated) {
          enqueueSnackbar({
            variant: 'info',
            message: 'Configuration updated from older format',
            autoHideDuration: 5000
          })
        } else {
          enqueueSnackbar({
            variant: 'success',
            message: 'Configuration opened successfully'
          })
        }

        if (wasMixedEndianness) {
          enqueueSnackbar({
            variant: 'warning',
            message: `Warning: Config had mixed byte order settings. Now using ${config.littleEndian ? 'Little' : 'Big'}-Endian globally. Please verify.`,
            autoHideDuration: 8000
          })
        }

        // A config from a newer Modbux is parsed against the current schema and
        // keeps what matches, so the warning says which fields did not come
        // across rather than that some feature may not work.
        if (futureVersion) {
          enqueueSnackbar({
            variant: 'warning',
            message: resetMessage('Server', futureVersion),
            // A notice that everything came across is not one the user has to
            // dismiss, and it sits on top of "Configuration opened
            // successfully" either way.
            persist: futureVersion.fields.length > 0,
            autoHideDuration: 8000
          })
        }
      } catch (error) {
        // `file.text()` rejects for a file that is gone by the time it is read.
        const tError = error as Error
        enqueueSnackbar({ variant: 'error', message: `Failed to load config: ${tError.message}` })
        console.error('Config load error:', error)
      } finally {
        // A file that is gone by the time it is read left `opening` true and
        // every server button disabled until the app was restarted, before
        // this was a `finally`.
        openingRef.current = false
        setOpening(false)
      }
    },
    [enqueueSnackbar]
  )

  return { opening, openingRef, open }
}

//
//
// Saving
type UseSaveHook = () => {
  save: () => void
}

const useSave: UseSaveHook = () => {
  const save = useCallback(() => {
    const json = exportServerConfig()
    if (json === undefined) return
    const { servers, selectedUuid } = useServerZustand.getState()
    const name = servers[selectedUuid]?.name ?? ''
    downloadJson(`modbux_server_${snakeCase(name)}.json`, json)
  }, [])

  return { save }
}

//
//
// Open save and clear the register configuration
const OpenSaveClear = meme(() => {
  const { opening, open } = useOpen()
  const { save } = useSave()

  const clear = useCallback(async () => {
    const serverZustand = useServerZustand.getState()
    await asOneServerStep(serverZustand.selectedUuid, async () => {
      serverZustand.setName('')
      await serverZustand.resetServer(serverZustand.selectedUuid)
    })
  }, [])

  return (
    <Box sx={{ display: 'flex', gap: 0 }}>
      <div>
        {!opening && (
          <input
            data-testid="server-open-file-input"
            accept="application/JSON"
            style={{ display: 'none' }}
            id="container-button-server-file"
            type="file"
            onChange={(e) => open(e.target.files?.[0])}
          />
        )}
        <label htmlFor="container-button-server-file">
          <IconButton
            data-testid="server-open-btn"
            aria-label="Open configuration"
            color="primary"
            disabled={opening}
            component="span"
            title="Open configuration"
          >
            <FileOpen fontSize="small" />
          </IconButton>
        </label>
      </div>
      <IconButton
        data-testid="server-save-btn"
        aria-label="Save configuration"
        title="Save configuration"
        color="primary"
        disabled={opening}
        onClick={save}
      >
        <Save fontSize="small" />
      </IconButton>
      <IconButton
        data-testid="server-clear-btn"
        aria-label="Clear configuration"
        title="Clear configuration"
        color="primary"
        disabled={opening}
        onClick={clear}
      >
        <Delete fontSize="small" />
      </IconButton>
    </Box>
  )
})

export default OpenSaveClear
