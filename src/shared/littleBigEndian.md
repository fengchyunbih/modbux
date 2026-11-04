What `reorderBytes` in `encoding.ts` does to a value, read from the PLC's side.

Two settings make four byte orders. `littleEndian` reverses the order of the 16-bit words, and `byteSwap` swaps the two bytes inside each word. Both apply to `int32`, `uint32`, `float`, `unix`, `int64`, `uint64`, `double` and `datetime`. `int16`, `uint16`, `bitmap` and `utf8` read the same in all four.

The tables use the `int32` value **305419896**, hexadecimal **0x12345678**, whose bytes from most to least significant are `A`=`0x12`, `B`=`0x34`, `C`=`0x56`, `D`=`0x78`. In SCL, `W1` is the most significant word of the `DWORD` and `W0` the least significant.

| Order    | `littleEndian` | `byteSwap` | Register 0 | Register 1 | SCL                                                   |
| -------- | -------------- | ---------- | ---------- | ---------- | ----------------------------------------------------- |
| **ABCD** | `false`        | `false`    | `0x1234`   | `0x5678`   | `registers[0] := W1; registers[1] := W0;`             |
| **CDAB** | `true`         | `false`    | `0x5678`   | `0x1234`   | `registers[0] := W0; registers[1] := W1;`             |
| **BADC** | `false`        | `true`     | `0x3412`   | `0x7856`   | `registers[0] := SWAP(W1); registers[1] := SWAP(W0);` |
| **DCBA** | `true`         | `true`     | `0x7856`   | `0x3412`   | `registers[0] := SWAP(W0); registers[1] := SWAP(W1);` |

A 64-bit value follows the same two rules over four words. With the bytes `0x0001020304050607`:

| Order    | Register 0 | Register 1 | Register 2 | Register 3 |
| -------- | ---------- | ---------- | ---------- | ---------- |
| **ABCD** | `0x0001`   | `0x0203`   | `0x0405`   | `0x0607`   |
| **CDAB** | `0x0607`   | `0x0405`   | `0x0203`   | `0x0001`   |
| **BADC** | `0x0100`   | `0x0302`   | `0x0504`   | `0x0706`   |
| **DCBA** | `0x0706`   | `0x0504`   | `0x0302`   | `0x0100`   |

The `reorderBytes` tests in `src/shared/__tests__/encoding.test.ts` assert both tables.

ABCD is the standard order in Modbus and in PLCs like Siemens S7, where `W1` comes first. The other three occur in devices that lay a value out differently; read a known value in each order to find the one a device uses.
