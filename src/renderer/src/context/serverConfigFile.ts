import {
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
 * The server config file for the selected server, as the text Save writes, or
 * undefined when the selection names no server.
 */
export const exportServerConfig = (): string | undefined => {
  const { servers, selectedUuid } = useServerZustand.getState()
  const server = servers[selectedUuid]
  if (!server) return undefined
  return serializeServerConfig({
    // The layout store reads the version once at startup.
    modbuxVersion: useLayoutZustand.getState().version,
    name: server.name ?? '',
    littleEndian: server.littleEndian,
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

/**
 * Reads a server config file into the selected server, as one step to undo.
 *
 * A file that does not parse changes nothing. A file that does replaces what
 * the server holds: a unit the file does not name is not written over on the
 * way in, so whatever the previous config left on it would answer a master
 * after this one is loaded, and the reset takes both sides down to nothing
 * first.
 *
 * A v4 file carries the port, and it goes through `setPort`, which refuses a
 * port another server holds and leaves main to refuse the rest. A refused
 * port does not stop the rest of the file, and the answer names it. A file
 * migrated from v3 carries none, and the server keeps the port it has. In RTU
 * mode the port is not applied, because no TCP server listens.
 */
export const importServerConfig = async (json: string): Promise<ServerConfigImport> => {
  // Before the reset, because the reset reaches main and then clears the
  // store: reset first, and a client config file or malformed JSON cost the
  // configuration on screen before anything had read the file.
  const parsed = parseServerConfig(json)
  if (!parsed.ok) return parsed
  const { config } = parsed

  const serverZustand = useServerZustand.getState()
  const uuid = serverZustand.selectedUuid
  let failure: string | undefined
  let portRefused: number | undefined

  await asOneServerStep(uuid, async () => {
    try {
      const port = config.port
      const listening = serverZustand.servers[uuid]?.port
      if (port !== undefined && serverZustand.serverMode !== 'rtu' && String(port) !== listening) {
        if (!(await serverZustand.setPort(String(port)))) portRefused = port
      }

      await serverZustand.resetServer(uuid)
      serverZustand.setName(config.name)
      serverZustand.setLittleEndian(config.littleEndian)

      for (const unitId of UnitIdStringSchema.options) {
        const serverRegisters = config.serverRegistersPerUnit[unitId]
        if (!serverRegisters) continue
        if (!checkHasConfig(serverRegisters)) continue
        serverZustand.replaceServerRegisters(unitId, serverRegisters)
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    } finally {
      // `init` runs either way: after a throw it hands main the configuration
      // the store holds, which is the one on screen.
      await serverZustand.init(uuid)
    }
  })

  return failure === undefined ? { ...parsed, portRefused } : { ok: false, error: failure }
}
