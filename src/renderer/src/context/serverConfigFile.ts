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
    registers: server.registers
  })
}

/**
 * Reads a server config file into the selected server, as one step to undo.
 *
 * A file that does not parse changes nothing. A file that does replaces what
 * the server holds: a unit the file does not name is not written over on the
 * way in, so whatever the previous config left on it would answer a master
 * after this one is loaded, and the reset takes both sides down to nothing
 * first.
 */
export const importServerConfig = async (json: string): Promise<ConfigFileResult<ServerConfig>> => {
  // Before the reset, because the reset reaches main and then clears the
  // store: reset first, and a client config file or malformed JSON cost the
  // configuration on screen before anything had read the file.
  const parsed = parseServerConfig(json)
  if (!parsed.ok) return parsed
  const { config } = parsed

  const serverZustand = useServerZustand.getState()
  const uuid = serverZustand.selectedUuid
  let failure: string | undefined

  await asOneServerStep(uuid, async () => {
    try {
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

  return failure === undefined ? parsed : { ok: false, error: failure }
}
