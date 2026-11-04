import {
  ConfigFileResult,
  parseClientConfig,
  RegisterMapConfig,
  serializeClientConfig
} from '@shared'
import { useClientZustand } from './client.zustand'
import { asOneClientStep, writeClientConfiguration } from './clientUndo'
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
  const { name, connectionConfig, registerConfig, registerMapping } = useClientZustand.getState()
  return serializeClientConfig({
    // The layout store reads the version once at startup.
    modbuxVersion: useLayoutZustand.getState().version,
    name,
    connectionConfig,
    registerConfig,
    registerMapping
  })
}

/** Why an import that parsed was refused, by what `writeClientConfiguration` answered. */
const REFUSALS = {
  'refused-connected':
    'The file holds other connection settings. Disconnect first, then open it again.',
  refused: 'Main refused the configuration, so the one before it is kept.'
} as const

/**
 * Reads a client config file into the store, as one step to undo.
 *
 * A file that does not parse changes nothing. A file that does sets the byte
 * order, the mapping and the name when it carries one. A v3 file carries the
 * connection and read settings too, and those are applied; a file migrated
 * from v2 carries neither, and the client keeps the ones it holds. Applying
 * other connection settings while a connection stands is refused, whole.
 */
export const importClientConfig = async (
  json: string
): Promise<ConfigFileResult<RegisterMapConfig>> => {
  const parsed = parseClientConfig(json)
  if (!parsed.ok) return parsed
  const { config } = parsed

  const current = useClientZustand.getState()
  // Asserted rather than annotated: an annotated `let` narrows to its
  // initializer, and the assignment inside the action is one control flow
  // analysis does not follow.
  let outcome = 'refused' as Awaited<ReturnType<typeof writeClientConfiguration>>
  try {
    await asOneClientStep(async () => {
      outcome = await writeClientConfiguration({
        name: config.name || current.name,
        connectionConfig: config.connectionConfig ?? current.connectionConfig,
        registerConfig: {
          ...(config.registerConfig ?? current.registerConfig),
          littleEndian: config.littleEndian
        },
        registerMapping: config.registerMapping
      })
    })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  return outcome === 'done' ? parsed : { ok: false, error: REFUSALS[outcome] }
}
