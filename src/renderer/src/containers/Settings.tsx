import Box from '@mui/material/Box'
import Fade from '@mui/material/Fade'
import Typography from '@mui/material/Typography'
import HomeButton from '@renderer/components/shared/HomeButton'
import McpSettings from '@renderer/components/settings/McpSettings/McpSettings'
import { meme } from '@renderer/components/shared/inputs/meme'

const Settings = meme((): JSX.Element => {
  return (
    <Fade in={true} timeout={500}>
      <Box
        sx={{
          p: 3,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          width: '100%',
          height: '100%',
          overflow: 'auto'
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <HomeButton />
          <Typography variant="h5">Settings</Typography>
        </Box>
        <McpSettings />
      </Box>
    </Fade>
  )
})

export default Settings
