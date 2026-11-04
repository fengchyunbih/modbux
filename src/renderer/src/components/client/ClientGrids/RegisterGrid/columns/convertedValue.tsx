import { GridColDef, GridRenderCellParams } from '@mui/x-data-grid/models'
import { useDataZustand } from '@renderer/context/data.zustand'
import { engineeringValue, RegisterData, RegisterMapObject } from '@shared'

/**
 * What a value cell shows, error included. `bitmapValueColumn` renders the same
 * cell for every row it does not turn into an expand toggle, and calling this
 * is how it says so.
 *
 * A number is the ordinary answer here: `getConvertedValue` rounds one and
 * `valueFormatter` passes it through, and `formattedValue` is `any`, so the
 * return type is the only place that says so.
 */
export const renderConvertedValue = (
  params: GridRenderCellParams<RegisterData>
): JSX.Element | string | number => {
  if (params.row.error) {
    return (
      <span style={{ color: 'var(--mui-palette-error-main)' }} title={params.row.error}>
        {params.row.error}
      </span>
    )
  }
  return params.formattedValue
}

export const convertedValueColumn = (
  registerMap: RegisterMapObject,
  showRaw: boolean
): GridColDef<RegisterData> => ({
  field: 'value',
  hideable: false,
  type: 'string',
  headerName: 'Value',
  width: 160,
  renderCell: renderConvertedValue,
  valueGetter: (_, row): number | string | undefined =>
    getConvertedValue(row, registerMap, showRaw),
  valueFormatter: (v) => (v !== undefined ? v : '')
})

/**
 * The value a cell reads, scaled and interpolated. `bitmapValueColumn` hands
 * every row that is not a bitmap back to this, and it takes the map and the
 * raw flag rather than reaching into the column it builds on.
 *
 * The conversion is `engineeringValue` in `@shared`, which main can call on the
 * rows of its own read. The groups are the ones the last read was made of,
 * which a utf8 string is cut to.
 */
export const getConvertedValue = (
  row: RegisterData,
  registerMap: RegisterMapObject,
  showRaw: boolean
): number | string | undefined =>
  engineeringValue(row, registerMap, useDataZustand.getState().addressGroups, showRaw)
