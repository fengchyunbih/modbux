import { useServerZustand } from '@renderer/context/server.zustand'
import { exportClientConfig, importClientConfig } from '@renderer/context/clientConfigFile'
import { exportProject, importProject } from '@renderer/context/projectFile'
import { exportServerConfig, importServerConfig } from '@renderer/context/serverConfigFile'
import { asOneServerStep } from '@renderer/context/serverUndo'
import {
  ClientImportResult,
  ConfigJson,
  ConfigFileResult,
  findAvailablePort,
  MAIN_SERVER_UUID,
  MCP_PORT,
  MCP_PORT_RESERVED,
  ProjectImportResult,
  ServerCreateResult,
  ServerDeleteResult,
  ServerImportResult
} from '@shared'
import { v4 } from 'uuid'
import { RendererCommandHandlers } from './dispatchRendererCommand'

/** The most servers the Add button allows. */
const MAX_SERVERS = 10

const SPLIT_OUT = 'The server view is in its own window; close it to use server commands'

/** The notes a successful import carries, whichever file it read. */
const notesOf = (
  result: Extract<ConfigFileResult<unknown>, { ok: true }>
): Extract<ClientImportResult, { ok: true }> => ({
  ok: true,
  migrated: result.migrated,
  fromVersion: result.fromVersion,
  wasMixedEndianness: result.wasMixedEndianness,
  futureVersion: result.futureVersion
})

type ConfigFileCommands = Pick<
  RendererCommandHandlers,
  | 'client_export_config'
  | 'client_import_config'
  | 'server_create'
  | 'server_delete'
  | 'server_export_config'
  | 'server_import_config'
  | 'project_export'
  | 'project_import'
>

/**
 * The config file commands, each calling the action its Save or Open button
 * calls, and the server commands the Add and Delete buttons' store actions.
 *
 * A server command is refused while the server view is split out, for the
 * reason `server_list` is: this window's server store is stale then.
 */
export const createConfigFileCommandHandlers = ({
  serverViewSplitOut
}: {
  serverViewSplitOut: () => boolean
}): ConfigFileCommands => {
  const refuseWhenSplitOut = (): void => {
    if (serverViewSplitOut()) throw new Error(SPLIT_OUT)
  }

  const requireServer = (uuid: string): void => {
    if (!useServerZustand.getState().servers[uuid]) throw new Error(`No server has uuid ${uuid}`)
  }

  return {
    client_export_config: () => ({ json: exportClientConfig() }),

    client_import_config: async ({ json }): Promise<ClientImportResult> => {
      const result = await importClientConfig(json)
      return result.ok ? notesOf(result) : { ok: false, error: result.error }
    },

    server_create: async ({ name, port }): Promise<ServerCreateResult> => {
      refuseWhenSplitOut()
      const serverZustand = useServerZustand.getState()
      if (serverZustand.serverMode === 'rtu') {
        return { ok: false, error: 'The server view is in RTU mode; switch it to TCP first' }
      }
      const used = Object.values(serverZustand.servers).map((server) => Number(server.port))
      if (used.length >= MAX_SERVERS) {
        return { ok: false, error: `Modbux holds at most ${MAX_SERVERS} servers` }
      }
      if (port === MCP_PORT) return { ok: false, error: MCP_PORT_RESERVED }
      if (port === 0) return { ok: false, error: 'A server needs a port between 1 and 65535' }
      if (port !== undefined && used.includes(port)) {
        return { ok: false, error: `Port ${port} is already used by another server` }
      }
      const chosen = port ?? findAvailablePort(used)
      if (chosen === undefined) return { ok: false, error: 'No free port between 502 and 10502' }

      const uuid = v4()
      let failure: string | undefined
      // One undo step: the create and the name together.
      await asOneServerStep(uuid, async () => {
        if (!(await serverZustand.createServer({ uuid, port: chosen }))) {
          failure = `Main did not create a server on port ${chosen}`
          return
        }
        // Main walks past a busy port. A port asked for by number is exact.
        const actual = useServerZustand.getState().servers[uuid]?.port
        if (port !== undefined && actual !== String(port)) {
          await useServerZustand.getState().deleteServer(uuid)
          failure = `Port ${port} is in use or refused by the system`
          return
        }
        if (name !== undefined) useServerZustand.getState().setName(name)
      })
      if (failure !== undefined) return { ok: false, error: failure }

      const created = useServerZustand.getState().servers[uuid]
      if (!created) return { ok: false, error: 'The server was not created' }
      return {
        ok: true,
        server: { uuid, name: created.name, port: created.port, unitId: created.unitId }
      }
    },

    server_delete: async ({ uuid }): Promise<ServerDeleteResult> => {
      refuseWhenSplitOut()
      if (uuid === MAIN_SERVER_UUID) {
        return { ok: false, error: 'The main server cannot be deleted' }
      }
      if (!useServerZustand.getState().servers[uuid]) {
        return { ok: false, error: `No server has uuid ${uuid}` }
      }
      await useServerZustand.getState().deleteServer(uuid)
      return { ok: true }
    },

    server_export_config: ({ uuid }): ConfigJson => {
      refuseWhenSplitOut()
      requireServer(uuid)
      const json = exportServerConfig(uuid)
      if (json === undefined) throw new Error(`No server has uuid ${uuid}`)
      return { json }
    },

    server_import_config: async ({ uuid, json }): Promise<ServerImportResult> => {
      refuseWhenSplitOut()
      requireServer(uuid)
      const previous = useServerZustand.getState().selectedUuid
      const result = await importServerConfig(json, uuid)
      // The import selects the server it fills. The Open button leaves it
      // selected because the user is looking at it; a tool call is not.
      if (useServerZustand.getState().servers[previous]) {
        useServerZustand.getState().setSelectedUuid(previous)
      }
      return result.ok
        ? { ...notesOf(result), portRefused: result.portRefused }
        : { ok: false, error: result.error }
    },

    project_export: (): ConfigJson => {
      refuseWhenSplitOut()
      return { json: exportProject() }
    },

    project_import: async ({ json }): Promise<ProjectImportResult> => {
      refuseWhenSplitOut()
      const result = await importProject(json)
      return result.ok
        ? {
            ...notesOf(result),
            portsRefused: result.portsRefused,
            serversRefused: result.serversRefused
          }
        : { ok: false, error: result.error }
    }
  }
}
