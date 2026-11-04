import Paper from '@mui/material/Paper'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import Typography from '@mui/material/Typography'
import { tableCellClasses } from '@mui/material/TableCell'
import { meme } from './meme'

/**
 * What the four byte orders do to one value, shown rather than described.
 *
 * This hangs off the byte order toggle as a tooltip, so it competes with the
 * app behind it and has to stay readable at a glance. The question a user has
 * is which bytes of a 32-bit value land in the first register, and one row per
 * order answers it.
 *
 * The hex carries the same monospace and colour as the HEX column in the
 * register grid, so a value looks the same wherever it appears.
 */

/** 0x12345678 in each order, and the SCL that writes it from a Siemens PLC. */
const ROWS: readonly { order: string; register0: string; register1: string; scl: string }[] = [
  {
    order: 'ABCD',
    register0: '0x1234',
    register1: '0x5678',
    scl: 'reg[0] := dWord.W1; reg[1] := dWord.W0;'
  },
  {
    order: 'CDAB',
    register0: '0x5678',
    register1: '0x1234',
    scl: 'reg[0] := dWord.W0; reg[1] := dWord.W1;'
  },
  {
    order: 'BADC',
    register0: '0x3412',
    register1: '0x7856',
    scl: 'reg[0] := SWAP(dWord.W1); reg[1] := SWAP(dWord.W0);'
  },
  {
    order: 'DCBA',
    register0: '0x7856',
    register1: '0x3412',
    scl: 'reg[0] := SWAP(dWord.W0); reg[1] := SWAP(dWord.W1);'
  }
]

const Hex = meme(
  ({ children }: { children: string }): JSX.Element => (
    <Typography
      component="span"
      sx={(theme) => ({
        fontFamily: 'monospace',
        color: theme.palette.primary.light,
        fontSize: '0.9em'
      })}
    >
      {children}
    </Typography>
  )
)

const EndianTable = meme(
  (): JSX.Element => (
    <Paper elevation={4} sx={{ px: 2, py: 1.5, width: 'fit-content' }}>
      <Typography sx={{ fontSize: 13 }}>
        32 bit value: <Hex>0x12345678</Hex>
      </Typography>

      {/*
        Set once here rather than per cell. The size comes down from the table,
        and Hex sizes itself against it in em rather than in pixels, so one
        number governs the lot. Padding does not come down: a cell brings its
        own, so the outer two are cleared with pseudo classes, which is the only
        way to reach first and last.
      */}
      <Table
        size="small"
        sx={{
          fontSize: 11,
          [`& .${tableCellClasses.root}`]: { whiteSpace: 'nowrap' },
          '& td:first-of-type, & th:first-of-type': { pl: 0 },
          '& td:last-of-type, & th:last-of-type': { pr: 0 }
        }}
      >
        <TableHead>
          <TableRow>
            <TableCell />
            <TableCell>Register 0</TableCell>
            <TableCell>Register 1</TableCell>
            <TableCell align="right">ST</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {ROWS.map(({ order, register0, register1, scl }) => (
            <TableRow key={order}>
              <TableCell>
                <Hex>{order}</Hex>
              </TableCell>
              <TableCell>
                <Hex>{register0}</Hex>
              </TableCell>
              <TableCell>
                <Hex>{register1}</Hex>
              </TableCell>
              <TableCell align="right">
                <Hex>{scl}</Hex>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Typography variant="caption" sx={{ display: 'block', mt: 1, opacity: 0.7 }}>
        ABCD puts the high word and the high byte first and is what most devices use. Pick the one
        your device uses, or every 32-bit and 64-bit value reads as nonsense. 16-bit values read the
        same in all four.
      </Typography>
    </Paper>
  )
)

export default EndianTable
