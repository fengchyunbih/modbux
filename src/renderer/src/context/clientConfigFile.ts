import {
  ConfigFileResult,
  parseClientConfig,
  RegisterMapConfig,
  serializeClientConfig
} from '@shared'
import { useClientZustand } from './client.zustand'
import { asOneClientStep } from './clientUndo'
import { showMapping } from './data.zustand'
import { useLayoutZustand } from './layout.zustand'

/**
 * Save and Open for the client, without the file.
 *
 * Here rather than on the store because the import records its own undo step
 * through `asOneClientStep`, and `undo.zustand` keeps the replays out of the
 * stores they replay into. The toolbar buttons call these two, and the command
 * channel from main in `docs/design/json-config-and-mcp.md` is to call the same.
 */

/** The client config file for what the store holds now, as the text Save writes. */
export const exportClientConfig = (): string => {
  const { name, registerConfig, registerMapping } = useClientZustand.getState()
  return serializeClientConfig({
    // The layout store reads the version once at startup.
    modbuxVersion: useLayoutZustand.getState().version,
    name,
    littleEndian: registerConfig.littleEndian,
    registerMapping
  })
}

/**
 * Reads a client config file into the store, as one step to undo.
 *
 * A file that does not parse changes nothing. A file that does sets the name
 * when it carries one, the byte order and the mapping, and then draws the grid
 * from the mapping.
 */
export const importClientConfig = async (
  json: string
): Promise<ConfigFileResult<RegisterMapConfig>> => {
  const parsed = parseClientConfig(json)
  if (!parsed.ok) return parsed
  const { config } = parsed

  const clientZustand = useClientZustand.getState()
  try {
    await asOneClientStep(async () => {
      if (config.name) clientZustand.setName(config.name)
      await clientZustand.setLittleEndian(config.littleEndian)
      await clientZustand.replaceRegisterMapping(config.registerMapping)
    })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  // Only for a file that was read: on a refused one the mapping is the one
  // already there, and the rows it draws would drop the values a read loop had
  // put in them.
  showMapping()
  return parsed
}
