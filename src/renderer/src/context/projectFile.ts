import {
  ConfigFileResult,
  DEFAULT_MODBUS_PORT,
  MAIN_SERVER_UUID,
  parseProject,
  Project,
  serializeProject
} from '@shared'
import { v4 } from 'uuid'
import { useClientZustand } from './client.zustand'
import { applyClientConfig, clientRefusal } from './clientConfigFile'
import { useLayoutZustand } from './layout.zustand'
import { getDefaultSerialConfig } from './server.zustand.helpers'
import { useServerZustand } from './server.zustand'
import { writeServerConfig } from './serverConfigFile'
import { asOneServerStep } from './serverUndo'

/**
 * Save project and Open project, without the file.
 *
 * One client config and every server, with the server view's mode and serial
 * settings. Each part is the same object its own file holds, so the builders
 * and the writers of `clientConfigFile` and `serverConfigFile` are the ones
 * used here.
 *
 * Undo: the client and the server store keep separate stacks, and one step
 * cannot span two. An import is one client step and one server step per server
 * it created, replaced or deleted. The mode and the serial settings are not
 * undoable, as the buttons that set them are not.
 */

/** The servers in file order: the main server first, then the others as made. */
const orderedUuids = (servers: Record<string, unknown>): string[] => {
  const others = Object.keys(servers).filter((uuid) => uuid !== MAIN_SERVER_UUID)
  return MAIN_SERVER_UUID in servers ? [MAIN_SERVER_UUID, ...others] : others
}

/** The project file for what the stores hold now, as the text Save project writes. */
export const exportProject = (): string => {
  const { name, connectionConfig, registerConfig, registerMapping } = useClientZustand.getState()
  const { servers, selectedUuid, serverMode = 'tcp', serialConfig } = useServerZustand.getState()
  // The layout store reads the version once at startup.
  const modbuxVersion = useLayoutZustand.getState().version
  const uuids = orderedUuids(servers)

  return serializeProject({
    modbuxVersion,
    client: { modbuxVersion, name, connectionConfig, registerConfig, registerMapping },
    servers: uuids.flatMap((uuid) => {
      const server = servers[uuid]
      if (!server) return []
      return [
        {
          modbuxVersion,
          name: server.name ?? '',
          littleEndian: server.littleEndian,
          port: Number(server.port),
          registers: server.registers
        }
      ]
    }),
    selectedServer: Math.max(0, uuids.indexOf(selectedUuid)),
    serverMode,
    serialConfig: serialConfig ?? getDefaultSerialConfig()
  })
}

/**
 * What opening a project answers. `portsRefused` names the ports a server asked
 * for that it did not get, `serversRefused` the servers main would not create.
 */
export type ProjectImport =
  | (Extract<ConfigFileResult<Project>, { ok: true }> & {
      portsRefused: number[]
      serversRefused: number
    })
  | Extract<ConfigFileResult<Project>, { ok: false }>

/** Takes the servers down to the main server, which stays because RTU serves it. */
const deleteOtherServers = async (): Promise<void> => {
  for (const uuid of Object.keys(useServerZustand.getState().servers)) {
    if (uuid !== MAIN_SERVER_UUID) await useServerZustand.getState().deleteServer(uuid)
  }
}

/**
 * Reads a project file into the stores.
 *
 * The whole file is parsed and validated before anything changes. The client
 * goes first, and a refusal there, the connection differing while a client is
 * connected, ends the import with nothing changed. A server main will not
 * create or bind to the port asked for does not stop the rest, and the answer
 * counts it.
 *
 * The servers are replaced: the main server takes the first server of the
 * file, every other server is deleted, and the rest of the file is created
 * new. Deleted first, so the ports they held are free for the file's.
 */
export const importProject = async (json: string): Promise<ProjectImport> => {
  const parsed = parseProject(json)
  if (!parsed.ok) return parsed
  const { config } = parsed

  try {
    const outcome = await applyClientConfig(config.client)
    if (outcome !== 'done') return { ok: false, error: clientRefusal(outcome) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  const portsRefused: number[] = []
  let serversRefused = 0
  const failures: string[] = []
  const note = (write: Awaited<ReturnType<typeof writeServerConfig>>): void => {
    if (write.portRefused !== undefined) portsRefused.push(write.portRefused)
    if (write.failure !== undefined) failures.push(write.failure)
  }

  // Servers in TCP mode, whatever the file says: an RTU run serves the main
  // server alone, and creating the rest would open TCP listeners beside it.
  if (useServerZustand.getState().serverMode === 'rtu') {
    await useServerZustand.getState().switchToTcp()
  }
  await deleteOtherServers()

  const uuids: string[] = []
  for (const [index, serverConfig] of config.servers.entries()) {
    const uuid = index === 0 ? MAIN_SERVER_UUID : v4()
    uuids.push(uuid)
    await asOneServerStep(uuid, async () => {
      if (index > 0) {
        const port = serverConfig.port ?? DEFAULT_MODBUS_PORT
        if (!(await useServerZustand.getState().createServer({ uuid, port }))) {
          serversRefused++
          return
        }
      }
      note(await writeServerConfig(uuid, serverConfig))
    })
  }

  const serverZustand = useServerZustand.getState()
  const { options, com } = config.serialConfig
  serverZustand.setServerCom(com)
  serverZustand.setServerBaudRate(options.baudRate)
  serverZustand.setServerDataBits(options.dataBits)
  serverZustand.setServerStopBits(options.stopBits)
  if (options.parity !== undefined) serverZustand.setServerParity(options.parity)
  if (config.serverMode === 'rtu') await serverZustand.switchToRtu()

  const selected = uuids[config.selectedServer]
  if (selected !== undefined && useServerZustand.getState().servers[selected]) {
    useServerZustand.getState().setSelectedUuid(selected)
  }

  if (failures.length > 0) return { ok: false, error: failures.join('; ') }
  return { ...parsed, portsRefused, serversRefused }
}
