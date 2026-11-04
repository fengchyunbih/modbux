// The text Save project writes and the result Open project reads: one client,
// every server, the server view's mode and serial settings. Each part is
// migrated by the migration of its own file, and a file of the wrong kind is
// refused by name in all three Open buttons.
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import {
  CURRENT_CLIENT_CONFIG_VERSION,
  CURRENT_PROJECT_VERSION,
  CURRENT_SERVER_CONFIG_VERSION,
  defaultConnectionConfig,
  defaultRegisterConfig,
  emptyRegisterMapping,
  migrateClientConfig,
  migrateServerConfig,
  parseClientConfig,
  parseProject,
  parseServerConfig,
  serializeClientConfig,
  serializeProject,
  serializeServerConfig,
  type ProjectSource,
  type ServerConfigSource,
  type ServerRegisters
} from '@shared'

const fixture = (name: string): string =>
  readFileSync(resolve(__dirname, '../../../e2e/fixtures/config-files', name), 'utf8')

const unit = (value: number): ServerRegisters => ({
  coils: {},
  discrete_inputs: {},
  input_registers: {},
  holding_registers: {
    5: {
      value,
      params: {
        address: 5,
        registerType: 'holding_registers',
        dataType: 'uint16',
        value,
        comment: 'pump'
      }
    }
  }
})

const firstServer = (): ServerConfigSource => ({
  modbuxVersion: '9.9.9',
  name: 'first',
  littleEndian: false,
  byteSwap: false,
  port: 1502,
  registers: { 0: unit(7) }
})

const secondServer = (): ServerConfigSource => ({
  modbuxVersion: '9.9.9',
  name: 'second',
  littleEndian: true,
  byteSwap: true,
  port: 1503,
  registers: { 3: unit(9) }
})

const source = (): ProjectSource => ({
  modbuxVersion: '9.9.9',
  client: {
    modbuxVersion: '9.9.9',
    name: 'boiler',
    connectionConfig: { ...defaultConnectionConfig, unitId: 17 },
    registerConfig: { ...defaultRegisterConfig, littleEndian: true, byteSwap: true },
    registerMapping: {
      ...emptyRegisterMapping(),
      holding_registers: { 0: { dataType: 'int16', comment: 'setpoint' } }
    }
  },
  servers: [firstServer(), secondServer()],
  selectedServer: 1,
  serverMode: 'rtu',
  serialConfig: {
    com: '/dev/ttyUSB1',
    options: { baudRate: '19200', parity: 'even', dataBits: 7, stopBits: 2 }
  }
})

const parsedOf = (json: string): ReturnType<typeof parseProject> & { ok: true } => {
  const parsed = parseProject(json)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed
}

describe('a project file', () => {
  it('reads back what it was written from', () => {
    const { config, migrated, fromVersion } = parsedOf(serializeProject(source()))

    expect(migrated).toBe(false)
    expect(fromVersion).toBe(CURRENT_PROJECT_VERSION)
    expect(config.kind).toBe('project')
    expect(config.client.name).toBe('boiler')
    expect(config.client.version).toBe(CURRENT_CLIENT_CONFIG_VERSION)
    expect(config.client.connectionConfig?.unitId).toBe(17)
    expect(config.client.littleEndian).toBe(true)
    expect(config.client.byteSwap).toBe(true)
    expect(
      config.servers.map((server) => [
        server.name,
        server.port,
        server.littleEndian,
        server.byteSwap
      ])
    ).toEqual([
      ['first', 1502, false, false],
      ['second', 1503, true, true]
    ])
    expect(config.servers.every((s) => s.version === CURRENT_SERVER_CONFIG_VERSION)).toBe(true)
    expect(config.servers[1]?.serverRegistersPerUnit['3']?.holding_registers['5']?.value).toBe(9)
    expect(config.selectedServer).toBe(1)
    expect(config.serverMode).toBe('rtu')
    expect(config.serialConfig).toEqual(source().serialConfig)
  })

  it('embeds the same objects the client and server files hold', () => {
    const written = JSON.parse(serializeProject(source()))
    const { client } = source()

    expect(written.client).toEqual(JSON.parse(serializeClientConfig(client)))
    expect(written.servers[0]).toEqual(JSON.parse(serializeServerConfig(firstServer())))
  })

  it('migrates a part with the migration of its own file', () => {
    const written = JSON.parse(serializeProject(source()))
    written.client = JSON.parse(fixture('client-basic.json'))
    written.servers[1] = JSON.parse(fixture('server-v1-legacy.json'))

    const result = parsedOf(JSON.stringify(written))

    expect(result.migrated).toBe(true)
    expect(result.config.client).toEqual(migrateClientConfig(fixture('client-basic.json')).config)
    expect(result.config.servers[1]).toEqual(
      migrateServerConfig(fixture('server-v1-legacy.json')).config
    )
    // The part that was current is left as it was.
    expect(result.config.servers[0]?.name).toBe('first')
  })

  it('reports a mixed byte order from a part that migrated it', () => {
    const written = JSON.parse(serializeProject(source()))
    const legacy = JSON.parse(fixture('server-v1-legacy.json'))
    const holding = legacy.serverRegistersPerUnit['0'].holding_registers
    holding['1'] = {
      ...holding['0'],
      params: { ...holding['0'].params, address: 1, littleEndian: true }
    }
    written.servers[1] = legacy

    expect(parsedOf(JSON.stringify(written))).toMatchObject({
      warning: 'MIXED_ENDIANNESS',
      wasMixedEndianness: true
    })
  })

  it('names the part that is invalid', () => {
    const written = JSON.parse(serializeProject(source()))
    written.servers[1].serverRegistersPerUnit = 'nope'

    expect(parseProject(JSON.stringify(written))).toEqual({
      ok: false,
      error: expect.stringMatching(/^Server 2 in project: /)
    })

    const badClient = JSON.parse(serializeProject(source()))
    badClient.client.registerMapping = 'nope'
    expect(parseProject(JSON.stringify(badClient))).toEqual({
      ok: false,
      error: expect.stringMatching(/^Client in project: /)
    })
  })

  it('round-trips a part with a byte swap', () => {
    const written = JSON.parse(serializeProject(source()))
    written.servers[0].byteSwap = true

    const parsed = parseProject(JSON.stringify(written))

    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.config.servers[0]?.byteSwap).toBe(true)
  })

  it('refuses a part whose byte swap is not a boolean', () => {
    const written = JSON.parse(serializeProject(source()))
    written.servers[0].byteSwap = 'yes'

    expect(parseProject(JSON.stringify(written))).toEqual({
      ok: false,
      error: expect.stringMatching(/Server 1 in project: .*byteSwap/)
    })
  })

  it('refuses a selected server the file does not hold', () => {
    const written = JSON.parse(serializeProject(source()))
    written.selectedServer = 2

    expect(parseProject(JSON.stringify(written))).toEqual({
      ok: false,
      error: expect.stringMatching(/selectedServer/)
    })
  })

  it('refuses a project without servers', () => {
    const written = JSON.parse(serializeProject(source()))
    written.servers = []

    expect(parseProject(JSON.stringify(written)).ok).toBe(false)
  })

  it('refuses a project from a newer Modbux by name', () => {
    const written = JSON.parse(serializeProject(source()))
    written.version = CURRENT_PROJECT_VERSION + 1

    expect(parseProject(JSON.stringify(written))).toEqual({
      ok: false,
      error: expect.stringMatching(/newer version of Modbux/)
    })
  })

  it('answers the reason for malformed JSON instead of throwing', () => {
    expect(parseProject('{ not json')).toEqual({ ok: false, error: expect.stringMatching(/JSON/) })
  })
})

describe('the wrong kind of file', () => {
  const client = serializeClientConfig(source().client)
  const server = serializeServerConfig(firstServer())
  const project = serializeProject(source())

  it('is named for a server config opened as a project', () => {
    expect(parseProject(server)).toEqual({
      ok: false,
      error: expect.stringContaining('This is a server configuration, not a project file')
    })
  })

  it('is named for a client config opened as a project', () => {
    expect(parseProject(client)).toEqual({
      ok: false,
      error: expect.stringContaining('This is a client configuration, not a project file')
    })
    expect(parseProject(fixture('client-basic.json'))).toMatchObject({ ok: false })
  })

  it('is named for any other JSON opened as a project', () => {
    expect(parseProject('{"a":1}')).toEqual({
      ok: false,
      error: 'This file is not a Modbux project file.'
    })
  })

  it('is named for a project opened in the client', () => {
    expect(parseClientConfig(project)).toEqual({
      ok: false,
      error: expect.stringContaining('This is a project file')
    })
  })

  it('is named for a project opened on the server', () => {
    expect(parseServerConfig(project)).toEqual({
      ok: false,
      error: expect.stringContaining('This is a project file')
    })
  })
})
