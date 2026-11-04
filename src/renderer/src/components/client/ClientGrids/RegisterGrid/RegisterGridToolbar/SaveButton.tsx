import Save from '@mui/icons-material/Save'
import IconButton from '@mui/material/IconButton'
import { downloadJson } from '@renderer/components/shared/downloadJson'
import { meme } from '@renderer/components/shared/inputs/meme'
import { useClientZustand } from '@renderer/context/client.zustand'
import { exportClientConfig } from '@renderer/context/clientConfigFile'
import { snakeCase } from 'lodash'
import { useCallback } from 'react'

const SaveButton = meme(() => {
  const saveRegisterConfig = useCallback(() => {
    const { name, connectionConfig } = useClientZustand.getState()
    downloadJson(
      `modbux_client_${snakeCase(name)}_id${connectionConfig.unitId}.json`,
      exportClientConfig()
    )
  }, [])

  return (
    <IconButton
      data-testid="save-config-btn"
      aria-label="Save configuration"
      size="small"
      onClick={saveRegisterConfig}
      color="primary"
      title="save datatype, scaling and comment configuration to json file"
    >
      <Save fontSize="small" />
    </IconButton>
  )
})

export default SaveButton
