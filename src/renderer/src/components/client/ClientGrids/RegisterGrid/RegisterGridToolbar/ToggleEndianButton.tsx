import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Tooltip from '@mui/material/Tooltip'
import { BYTE_ORDER_OPTIONS } from '@renderer/components/shared/inputs/byteOrderOptions'
import EndianTable from '@renderer/components/shared/inputs/EndianTable'
import { meme } from '@renderer/components/shared/inputs/meme'
import { useClientZustand } from '@renderer/context/client.zustand'
import { useCallback } from 'react'
import { ByteOrder, byteOrderOf, isNumberRegister } from '@shared'

const ToggleEndianButton = meme((): JSX.Element | null => {
  const type = useClientZustand((z) => z.registerConfig.type)
  const littleEndian = useClientZustand((z) => z.registerConfig.littleEndian)
  const byteSwap = useClientZustand((z) => z.registerConfig.byteSwap)

  const handleChange = useCallback((_event: unknown, value: ByteOrder | null): void => {
    if (value === null) return
    const clientZustand = useClientZustand.getState()
    clientZustand.setByteOrder(value)
  }, [])

  const registers16Bit = isNumberRegister(type)
  if (!registers16Bit) return null

  return (
    <Tooltip
      slotProps={{ tooltip: { sx: { background: 'transparent', m: 0 } } }}
      title={<EndianTable />}
      enterDelay={1000}
    >
      <ToggleButtonGroup
        sx={{ height: 29.5 }}
        size="small"
        exclusive
        color="primary"
        value={byteOrderOf({ littleEndian, byteSwap })}
        onChange={handleChange}
      >
        {BYTE_ORDER_OPTIONS.map(({ order, testId }) => (
          <ToggleButton
            key={order}
            data-testid={`endian-${testId}-btn`}
            aria-label={order}
            value={order}
            sx={{ fontFamily: 'monospace', px: 1 }}
          >
            {order}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
    </Tooltip>
  )
})

export default ToggleEndianButton
