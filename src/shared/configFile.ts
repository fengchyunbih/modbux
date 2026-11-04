import {
  ConnectionConfig,
  RegisterConfig,
  RegisterMapConfig,
  RegisterMapping
} from './types/client'
import { RegisterTypeSchema } from './types/register'
import { ServerConfig, ServerRegistersPerUnit } from './types/server'
import { checkHasConfig } from './utils'
import {
  CURRENT_CLIENT_CONFIG_VERSION,
  CURRENT_SERVER_CONFIG_VERSION,
  MigrationResult,
  migrateClientConfig,
  migrateServerConfig
} from './migrations'

/**
 * What reading a config file answers: the migrated config, or why it was
 * refused.
 *
 * `migrateClientConfig` and `migrateServerConfig` throw, on malformed JSON, on
 * the other side's file and on a schema failure. Both the Open buttons and a
 * caller in main need the reason as a value, so the throw stops here.
 */
export type ConfigFileResult<T> = ({ ok: true } & MigrationResult<T>) | { ok: false; error: string }

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const readConfigFile = <T>(
  migrate: (json: string) => MigrationResult<T>,
  json: string
): ConfigFileResult<T> => {
  try {
    return { ok: true, ...migrate(json) }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

/** Parses, migrates and validates a client config file. */
export const parseClientConfig = (json: string): ConfigFileResult<RegisterMapConfig> =>
  readConfigFile(migrateClientConfig, json)

/** Parses, migrates and validates a server config file. */
export const parseServerConfig = (json: string): ConfigFileResult<ServerConfig> =>
  readConfigFile(migrateServerConfig, json)

/** What the client store holds that a client config file carries. */
export interface ClientConfigSource {
  modbuxVersion: string
  name: string
  connectionConfig: ConnectionConfig
  registerConfig: RegisterConfig
  registerMapping: RegisterMapping
}

/**
 * The client config file for `source`, as the text Save writes.
 *
 * An entry whose data type is `none` is left out, as Save always did:
 * `setRegisterMapping` deletes an entry set to `none`, so one that is still
 * there maps nothing.
 */
export const serializeClientConfig = (source: ClientConfigSource): string =>
  JSON.stringify(buildClientConfig(source), null, 2)

/** The client config object Save writes, shared with the project file that embeds it. */
export const buildClientConfig = (source: ClientConfigSource): RegisterMapConfig => {
  const registerMapping = structuredClone(source.registerMapping)
  for (const registerType of RegisterTypeSchema.options) {
    const entries = registerMapping[registerType]
    for (const address of Object.keys(entries).map(Number)) {
      if (entries[address]?.dataType === 'none') delete entries[address]
    }
  }

  const { littleEndian, ...readSettings } = source.registerConfig
  return {
    version: CURRENT_CLIENT_CONFIG_VERSION,
    modbuxVersion: source.modbuxVersion,
    name: source.name,
    littleEndian,
    byteSwap: false,
    connectionConfig: source.connectionConfig,
    registerConfig: readSettings,
    registerMapping
  }
}

/** What one server in the store holds that a server config file carries. */
export interface ServerConfigSource {
  modbuxVersion: string
  name: string
  littleEndian: boolean
  port: number
  registers: ServerRegistersPerUnit
}

/**
 * The server config file for `source`, as the text Save writes.
 *
 * A unit holding nothing is left out, so a file names the units it configures.
 */
export const serializeServerConfig = (source: ServerConfigSource): string =>
  JSON.stringify(buildServerConfig(source), null, 2)

/** The server config object Save writes, shared with the project file that embeds it. */
export const buildServerConfig = (source: ServerConfigSource): ServerConfig => {
  const serverRegistersPerUnit: ServerRegistersPerUnit = {}
  for (const [unitId, registers] of Object.entries(source.registers)) {
    if (checkHasConfig(registers)) serverRegistersPerUnit[unitId] = registers
  }

  return {
    version: CURRENT_SERVER_CONFIG_VERSION,
    modbuxVersion: source.modbuxVersion,
    name: source.name,
    littleEndian: source.littleEndian,
    byteSwap: false,
    port: source.port,
    serverRegistersPerUnit
  }
}
