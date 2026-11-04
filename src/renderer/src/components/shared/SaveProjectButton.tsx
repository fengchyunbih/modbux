import Save from '@mui/icons-material/Save'
import Button from '@mui/material/Button'
import { downloadJson } from '@renderer/components/shared/downloadJson'
import { meme } from '@renderer/components/shared/inputs/meme'
import { exportProject } from '@renderer/context/projectFile'
import { isServerViewSplitOut } from '@renderer/context/serverViewSplitOut'
import { useSnackbar } from 'notistack'
import { useCallback } from 'react'

const SaveProjectButton = meme((): JSX.Element => {
  const { enqueueSnackbar } = useSnackbar()

  const saveProject = useCallback(() => {
    if (isServerViewSplitOut()) {
      enqueueSnackbar({
        variant: 'error',
        message: 'The server view is in its own window. Close that window to save the project.'
      })
      return
    }
    downloadJson('modbux_project.json', exportProject())
  }, [enqueueSnackbar])

  return (
    <Button
      data-testid="save-project-btn"
      startIcon={<Save />}
      size="small"
      onClick={saveProject}
      title="Save the client configuration and every server to one json file"
    >
      Save project
    </Button>
  )
})

export default SaveProjectButton
