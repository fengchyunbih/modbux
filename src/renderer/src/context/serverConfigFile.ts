import {
  byteOrderOf,
  checkHasConfig,
  ConfigFileResult,
  parseServerConfig,
  serializeServerConfig,
  ServerConfig,
  UnitIdStringSchema
} from '@shared'
import { useLayoutZustand } from './layout.zustand'
import { useServerZustand } from './server.zustand'
import { asOneServerStep } from './serverUndo'

/**
 * Save and Open for the selected server, without the file.
 *
 * Here rather than on the store because the import records its own undo step
 * through `asOneServerStep`, and `undo.zustand` keeps the replays out of the
 * stores they replay into. `OpenSaveClear` calls these two, and the command
 * channel from main in `docs/design/json-config-and-mcp.md` is to call the same.
 */

/**
 * The server config file for server `uuid` (the selected one by default), as
 * the text Save writes, or undefined when no server has that uuid.
 */
export const exportServerConfig = (
  uuid: string = useServerZustand.getState().selectedUuid
): string | undefined => {
  const server = useServerZustand.getState().servers[uuid]
  if (!server) return undefined
  return serializeServerConfig({
    // The layout store reads the version once at startup.
    modbuxVersion: useLayoutZustand.getState().version,
    name: server.name ?? '',
    littleEndian: server.littleEndian,
    byteSwap: server.byteSwap,
    port: Number(server.port),
    registers: server.registers
  })
}

/**
 * What opening a server config file answers. `portRefused` names the port a
 * file asked for that the server did not take, and the server keeps the one
 * it listens on.
 */
export type ServerConfigImport =
  | (Extract<ConfigFileResult<ServerConfig>, { ok: true }> & { portRefused?: number })
  | Extract<ConfigFileResult<ServerConfig>, { ok: false }>

/** What `writeServerConfig` could not do, with the rest of the file written anyway. */
export interface ServerConfigWrite {
  failure?: string
  portRefused?: number
}

/**
 * Replaces what server `uuid` holds with `config`, and selects it.
 *
 * Not recorded: the callers wrap it in `asOneServerStep`, which is one step
 * for the Open button and one per server for the project import.
 *
 * A server the config does not name a unit of is reset first, so whatever the
 * previous config left on it would not answer a master after this one is
 * loaded. A port the config carries goes through `setPort`, which refuses a
 * port another server holds and leaves main to refuse the rest. A refused port
 * does not stop the rest of the config. In RTU mode the port is not applied,
 * because no TCP server listens.
 */
export const writeServerConfig = async (
  uuid: string,
  config: ServerConfig
): Promise<ServerConfigWrite> => {
  useServerZustand.getState().setSelectedUuid(uuid)
  const serverZustand = useServerZustand.getState()
  const write: ServerConfigWrite = {}

  try {
    const port = config.port
    const listening = serverZustand.servers[uuid]?.port
    if (port !== undefined && serverZustand.serverMode !== 'rtu' && String(port) !== listening) {
      if (!(await serverZustand.setPort(String(port)))) write.portRefused = port
    }

    await serverZustand.resetServer(uuid)
    serverZustand.setName(config.name)
    serverZustand.setByteOrder(
      byteOrderOf({ littleEndian: config.littleEndian, byteSwap: config.byteSwap ?? false })
    )

    for (const unitId of UnitIdStringSchema.options) {
      const serverRegisters = config.serverRegistersPerUnit[unitId]
      if (!serverRegisters) continue
      if (!checkHasConfig(serverRegisters)) continue
      serverZustand.replaceServerRegisters(unitId, serverRegisters)
    }
  } catch (error) {
    write.failure = error instanceof Error ? error.message : String(error)
  } finally {
    // `init` runs either way: after a throw it hands main the configuration
    // the store holds, which is the one on screen.
    await serverZustand.init(uuid)
  }
  return write
}

/**
 * Reads a server config file into server `uuid` (the selected one by default),
 * as one step to undo. The server ends up selected, as after Open.
 *
 * A file that does not parse changes nothing, and the parse comes before the
 * reset because the reset reaches main and then clears the store. A file
 * migrated from v3 carries no port, and the server keeps the port it has.
 */
export const importServerConfig = async (
  json: string,
  uuid: string = useServerZustand.getState().selectedUuid
): Promise<ServerConfigImport> => {
  const parsed = parseServerConfig(json)
  if (!parsed.ok) return parsed
  const { config } = parsed

  let write: ServerConfigWrite = {}
  await asOneServerStep(uuid, async () => {
    write = await writeServerConfig(uuid, config)
  })

  return write.failure === undefined
    ? { ...parsed, portRefused: write.portRefused }
    : { ok: false, error: write.failure }
}
