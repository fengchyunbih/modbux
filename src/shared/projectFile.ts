import type { ConfigReset } from './repairPersisted'
import {
  buildClientConfig,
  buildServerConfig,
  ClientConfigSource,
  ConfigFileResult,
  ServerConfigSource
} from './configFile'
import { formatZodError, migrateClientConfig, migrateServerConfig } from './migrations'
import { parseConfigFile } from './migrations/shared'
import { ServerMode, ServerSerialConfig } from './types/server'
import {
  CURRENT_PROJECT_VERSION,
  PROJECT_KIND,
  Project,
  ProjectEnvelopeSchema,
  ProjectFileSchema
} from './types/project'

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** What the stores hold that a project file carries. */
export interface ProjectSource {
  modbuxVersion: string
  client: ClientConfigSource
  /** The main server first. */
  servers: ServerConfigSource[]
  selectedServer: number
  serverMode: ServerMode
  serialConfig: ServerSerialConfig
}

/** The project file for `source`, as the text Save project writes. */
export const serializeProject = (source: ProjectSource): string => {
  const project: Project = {
    kind: PROJECT_KIND,
    version: CURRENT_PROJECT_VERSION,
    modbuxVersion: source.modbuxVersion,
    client: buildClientConfig(source.client),
    servers: source.servers.map(buildServerConfig),
    selectedServer: source.selectedServer,
    serverMode: source.serverMode,
    serialConfig: source.serialConfig
  }
  return JSON.stringify(project, null, 2)
}

/** Why a file without the project kind is not one, by what it looks like. */
const notAProject = (parsed: Record<string, unknown>): string => {
  if ('serverRegistersPerUnit' in parsed || 'serverRegisters' in parsed) {
    return 'This is a server configuration, not a project file. It opens on the server.'
  }
  if ('registerMapping' in parsed || 'version' in parsed) {
    return 'This is a client configuration, not a project file. It opens in the client.'
  }
  return 'This file is not a Modbux project file.'
}

const readProject = (json: string): ConfigFileResult<Project> => {
  const { parsed } = parseConfigFile(json)
  if (parsed.kind !== PROJECT_KIND) return { ok: false, error: notAProject(parsed) }

  const { version } = parsed
  if (typeof version === 'number' && version > CURRENT_PROJECT_VERSION) {
    return {
      ok: false,
      error: `This project was saved by a newer version of Modbux (project file v${version}).`
    }
  }

  const envelope = ProjectEnvelopeSchema.safeParse(parsed)
  if (!envelope.success) {
    return { ok: false, error: `Invalid project file: ${formatZodError(envelope.error)}` }
  }
  const { data } = envelope

  // Each part goes through the migration of its own file, so this format
  // holds no copy of their history. A part that fails names itself.
  const reset: ConfigReset = { fields: [], savedByNewerVersion: false }
  let migrated = false
  let wasMixedEndianness = false

  const noteReset = (label: string, part: ConfigReset | undefined): void => {
    if (!part) return
    reset.savedByNewerVersion ||= part.savedByNewerVersion
    reset.fields.push(...part.fields.map((field) => `${label} ${field}`))
  }

  let client: Project['client']
  try {
    const result = migrateClientConfig(JSON.stringify(data.client))
    client = result.config
    migrated ||= result.migrated
    noteReset('client', result.futureVersion)
  } catch (error) {
    return { ok: false, error: `Client in project: ${messageOf(error)}` }
  }

  const servers: Project['servers'] = []
  for (const [index, embedded] of data.servers.entries()) {
    try {
      const result = migrateServerConfig(JSON.stringify(embedded))
      servers.push(result.config)
      migrated ||= result.migrated
      wasMixedEndianness ||= result.wasMixedEndianness === true
      noteReset(`server ${index + 1}`, result.futureVersion)
    } catch (error) {
      return { ok: false, error: `Server ${index + 1} in project: ${messageOf(error)}` }
    }
  }

  const checked = ProjectFileSchema.safeParse({ ...data, client, servers })
  if (!checked.success) {
    return { ok: false, error: `Invalid project file: ${formatZodError(checked.error)}` }
  }

  const anyReset = reset.savedByNewerVersion || reset.fields.length > 0
  return {
    ok: true,
    config: checked.data,
    migrated,
    fromVersion: data.version,
    warning: wasMixedEndianness ? 'MIXED_ENDIANNESS' : undefined,
    wasMixedEndianness,
    futureVersion: anyReset ? reset : undefined
  }
}

/** Parses, migrates and validates a project file. Never throws. */
export const parseProject = (json: string): ConfigFileResult<Project> => {
  try {
    return readProject(json)
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}
