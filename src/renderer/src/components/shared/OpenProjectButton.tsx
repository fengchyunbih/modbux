import FileOpen from '@mui/icons-material/FileOpen'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import { meme } from '@renderer/components/shared/inputs/meme'
import { importProject } from '@renderer/context/projectFile'
import { isServerViewSplitOut } from '@renderer/context/serverViewSplitOut'
import { useSnackbar } from 'notistack'
import { useCallback, useRef, useState } from 'react'

const OpenProjectButton = meme((): JSX.Element => {
  const openingRef = useRef(false)
  const [opening, setOpening] = useState(false)

  const { enqueueSnackbar } = useSnackbar()

  const openProject = useCallback(
    async (file: File | undefined) => {
      if (!file) return
      if (openingRef.current) return
      if (isServerViewSplitOut()) {
        enqueueSnackbar({
          variant: 'error',
          message: 'The server view is in its own window. Close that window to open a project.'
        })
        return
      }
      openingRef.current = true
      setOpening(true)

      try {
        const outcome = await importProject(await file.text())
        if (!outcome.ok) {
          enqueueSnackbar({ variant: 'error', message: `Failed to open project: ${outcome.error}` })
          return
        }
        const { migrated, wasMixedEndianness, futureVersion, portsRefused, serversRefused } =
          outcome

        if (migrated) {
          enqueueSnackbar({
            variant: 'info',
            message: 'Project updated from older format',
            autoHideDuration: 5000
          })
        } else {
          enqueueSnackbar({ variant: 'success', message: 'Project opened successfully' })
        }

        if (wasMixedEndianness) {
          enqueueSnackbar({
            variant: 'warning',
            message: 'A server in the project had mixed byte order settings. Please verify them.',
            autoHideDuration: 8000
          })
        }

        if (portsRefused.length > 0) {
          enqueueSnackbar({
            variant: 'warning',
            message: `Port ${portsRefused.join(', ')} from the project was not applied. The rest was opened.`,
            autoHideDuration: 8000
          })
        }

        if (serversRefused > 0) {
          enqueueSnackbar({
            variant: 'warning',
            message: `${serversRefused} server${serversRefused === 1 ? '' : 's'} from the project could not be created.`,
            autoHideDuration: 8000
          })
        }

        if (futureVersion) {
          enqueueSnackbar({
            variant: 'warning',
            message:
              futureVersion.fields.length > 0
                ? `The project was saved by a newer version of Modbux, and ${futureVersion.fields.join(', ')} did not come across.`
                : 'The project was saved by a newer version of Modbux and was read in full.',
            persist: futureVersion.fields.length > 0,
            autoHideDuration: 8000
          })
        }
      } catch (error) {
        // `file.text()` rejects for a file that is gone by the time it is read.
        const tError = error as Error
        enqueueSnackbar({ variant: 'error', message: `Failed to open project: ${tError.message}` })
        console.error('Project open error:', error)
      } finally {
        openingRef.current = false
        setOpening(false)
      }
    },
    [enqueueSnackbar]
  )

  return (
    <Box>
      {!opening && (
        <input
          data-testid="open-project-file-input"
          accept="application/JSON"
          style={{ display: 'none' }}
          id="open-project-file"
          type="file"
          onChange={(e) => openProject(e.target.files?.[0])}
        />
      )}
      <label htmlFor="open-project-file">
        <Button
          data-testid="open-project-btn"
          startIcon={<FileOpen />}
          size="small"
          disabled={opening}
          component="span"
          title="Open a project file: replaces the client configuration and every server"
        >
          Open project
        </Button>
      </label>
    </Box>
  )
})

export default OpenProjectButton
