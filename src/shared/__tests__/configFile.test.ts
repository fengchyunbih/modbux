// The text Save writes and the result Open reads, without a file and without a
// throw: a refused file answers its reason as a value.
import { describe, expect, it } from 'vitest'
import {
  CURRENT_CLIENT_CONFIG_VERSION,
  CURRENT_SERVER_CONFIG_VERSION,
  ConnectionConfig,
  defaultConnectionConfig,
  defaultRegisterConfig,
  emptyRegisterMapping,
  RegisterConfig,
  parseClientConfig,
  parseServerConfig,
  serializeClientConfig,
  serializeServerConfig,
  ServerRegisters
} from '@shared'

/** Every connection field off its default, so a field the file drops shows. */
const connection: ConnectionConfig = {
  protocol: 'ModbusRtu',
  unitId: 17,
  tcp: { host: '10.0.0.5', options: { port: 1502 } },
  rtu: {
    com: '/dev/ttyUSB1',
    options: { baudRate: '19200', parity: 'even', dataBits: 7, stopBits: 2 }
  }
}

/** Every register config field off its default. */
const readSettings: RegisterConfig = {
  address: 40,
  length: 20,
  type: 'input_registers',
  pollRate: 3000,
  timeout: 2000,
  littleEndian: true,
  byteSwap: true,
  advancedMode: true,
  show64BitValues: true,
  addressBase: '1'
}

const clientSource = (): Parameters<typeof serializeClientConfig>[0] => ({
  modbuxVersion: '9.9.9',
  name: 'boiler',
  connectionConfig: connection,
  registerConfig: readSettings,
  registerMapping: {
    ...emptyRegisterMapping(),
    holding_registers: {
      0: { dataType: 'int16', comment: 'setpoint' },
      1: { dataType: 'none', comment: 'nothing' }
    }
  }
})

const unitWithOneRegister = (): ServerRegisters => ({
  coils: {},
  discrete_inputs: {},
  input_registers: {},
  holding_registers: {
    5: {
      value: 7,
      params: {
        address: 5,
        registerType: 'holding_registers',
        dataType: 'uint16',
        value: 7,
        comment: 'pump'
      }
    }
  }
})

const emptyUnit = (): ServerRegisters => ({
  coils: {},
  discrete_inputs: {},
  input_registers: {},
  holding_registers: {}
})

describe('a client config file', () => {
  it('reads back what it was written from', () => {
    const parsed = parseClientConfig(serializeClientConfig(clientSource()))

    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.migrated).toBe(false)
    expect(parsed.config.version).toBe(CURRENT_CLIENT_CONFIG_VERSION)
    expect(parsed.config.modbuxVersion).toBe('9.9.9')
    expect(parsed.config.name).toBe('boiler')
    expect(parsed.config.littleEndian).toBe(true)
    expect(parsed.config.byteSwap).toBe(true)
    expect(parsed.config.connectionConfig).toEqual(connection)
    expect(parsed.config.registerConfig).toEqual({
      ...readSettings,
      littleEndian: undefined,
      byteSwap: undefined
    })
    expect(parsed.config.registerMapping.holding_registers[0]).toEqual({
      dataType: 'int16',
      comment: 'setpoint'
    })
  })

  it('leaves out an entry whose data type is none, and leaves the store alone', () => {
    const source = clientSource()
    const written = JSON.parse(serializeClientConfig(source))

    expect(Object.keys(written.registerMapping.holding_registers)).toEqual(['0'])
    expect(source.registerMapping.holding_registers[1]).toEqual({
      dataType: 'none',
      comment: 'nothing'
    })
  })

  it('answers the reason for malformed JSON instead of throwing', () => {
    expect(parseClientConfig('{ not json')).toEqual({
      ok: false,
      error: expect.stringMatching(/JSON/)
    })
  })

  it('answers the reason for a server config', () => {
    const parsed = parseClientConfig(
      serializeServerConfig({
        modbuxVersion: '9.9.9',
        name: '',
        littleEndian: false,
        byteSwap: false,
        port: 502,
        registers: {}
      })
    )

    expect(parsed).toEqual({
      ok: false,
      error: 'This is not a client configuration. A server configuration opens on the server.'
    })
  })
})

describe('a server config file', () => {
  it('reads back what it was written from', () => {
    const parsed = parseServerConfig(
      serializeServerConfig({
        modbuxVersion: '9.9.9',
        name: 'meter',
        littleEndian: true,
        byteSwap: true,
        port: 1502,
        registers: { '3': unitWithOneRegister() }
      })
    )

    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.migrated).toBe(false)
    expect(parsed.config.version).toBe(CURRENT_SERVER_CONFIG_VERSION)
    expect(parsed.config.name).toBe('meter')
    expect(parsed.config.littleEndian).toBe(true)
    expect(parsed.config.byteSwap).toBe(true)
    expect(parsed.config.port).toBe(1502)
    expect(parsed.config.serverRegistersPerUnit['3']).toEqual(unitWithOneRegister())
  })

  it('leaves out a unit that holds nothing', () => {
    const written = JSON.parse(
      serializeServerConfig({
        modbuxVersion: '9.9.9',
        name: 'meter',
        littleEndian: false,
        byteSwap: false,
        port: 502,
        registers: { '0': emptyUnit(), '3': unitWithOneRegister() }
      })
    )

    expect(Object.keys(written.serverRegistersPerUnit)).toEqual(['3'])
  })

  it('answers the reason for a client config', () => {
    const parsed = parseServerConfig(serializeClientConfig(clientSource()))

    expect(parsed).toEqual({
      ok: false,
      error: 'This is not a server configuration. A client configuration opens in the client.'
    })
  })
})

/** The text of a file Save writes, with `edit` applied to its JSON. */
const editedClientFile = (edit: (file: Record<string, unknown>) => void): string => {
  const file = JSON.parse(serializeClientConfig(clientSource()))
  edit(file)
  return JSON.stringify(file)
}

const editedServerFile = (edit: (file: Record<string, unknown>) => void): string => {
  const file = JSON.parse(
    serializeServerConfig({
      modbuxVersion: '9.9.9',
      name: 'meter',
      littleEndian: false,
      byteSwap: false,
      port: 1502,
      registers: { '0': unitWithOneRegister() }
    })
  )
  edit(file)
  return JSON.stringify(file)
}

const byteSwapRefusal = {
  ok: false,
  error: expect.stringContaining('byteSwap: Expected boolean, received string')
}

describe('a client config file from v2', () => {
  it('opens with no connection or read settings, so the client keeps its own', () => {
    const parsed = parseClientConfig(
      editedClientFile((file) => {
        file.version = 2
        delete file.byteSwap
        delete file.connectionConfig
        delete file.registerConfig
      })
    )

    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.migrated).toBe(true)
    expect(parsed.fromVersion).toBe(2)
    expect(parsed.config.version).toBe(3)
    expect(parsed.config.littleEndian).toBe(true)
    expect(parsed.config.registerMapping.holding_registers[0]).toEqual({
      dataType: 'int16',
      comment: 'setpoint'
    })
    expect(parsed.config.connectionConfig).toBeUndefined()
    expect(parsed.config.registerConfig).toBeUndefined()
  })

  it('drops the settings a hand-edited v2 file carries, which v2 never wrote', () => {
    const parsed = parseClientConfig(editedClientFile((file) => (file.version = 2)))

    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.config.connectionConfig).toBeUndefined()
    expect(parsed.config.registerConfig).toBeUndefined()
  })
})

describe('a client config file and its byte swap', () => {
  it('opens without the field or with it false, as a file from before byte swap did', () => {
    const absent = parseClientConfig(editedClientFile((file) => delete file.byteSwap))
    const off = parseClientConfig(editedClientFile((file) => (file.byteSwap = false)))

    expect(absent).toMatchObject({ ok: true, config: { littleEndian: true } })
    expect(absent).not.toHaveProperty('config.byteSwap')
    expect(off).toMatchObject({ ok: true, config: { littleEndian: true, byteSwap: false } })
  })

  it.each([
    ['this version', CURRENT_CLIENT_CONFIG_VERSION],
    ['a newer Modbux, whose fields are repaired one by one', 9]
  ])('opens with it true from %s', (_from, version) => {
    const parsed = parseClientConfig(
      editedClientFile((file) => {
        file.version = version
        file.byteSwap = true
      })
    )

    expect(parsed).toMatchObject({ ok: true, config: { littleEndian: true, byteSwap: true } })
  })

  it('drops it from a hand-edited v2 file, which v2 never wrote', () => {
    const parsed = parseClientConfig(
      editedClientFile((file) => {
        file.version = 2
        file.byteSwap = true
      })
    )

    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.config.byteSwap).toBeUndefined()
  })

  it('is refused by name when it is not a boolean', () => {
    const parsed = parseClientConfig(editedClientFile((file) => (file.byteSwap = 'yes')))

    expect(parsed).toEqual(byteSwapRefusal)
  })
})

describe('a client config file from a newer Modbux', () => {
  it('keeps the connection settings it shares, and names the read settings it does not', () => {
    const parsed = parseClientConfig(
      editedClientFile((file) => {
        file.version = 9
        file.registerConfig = { address: 'not an address' }
      })
    )

    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.config.connectionConfig).toEqual(connection)
    expect(parsed.config.registerConfig).toBeUndefined()
    expect(parsed.futureVersion?.fields).toEqual(['registerConfig'])
  })
})

describe('a server config file from v3', () => {
  it('opens with no port, so the server keeps its own', () => {
    const parsed = parseServerConfig(
      editedServerFile((file) => {
        file.version = 3
        delete file.byteSwap
        delete file.port
      })
    )

    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.migrated).toBe(true)
    expect(parsed.fromVersion).toBe(3)
    expect(parsed.config.version).toBe(4)
    expect(parsed.config.port).toBeUndefined()
    expect(parsed.config.serverRegistersPerUnit['0']).toEqual(unitWithOneRegister())
  })

  it('drops the port a hand-edited v3 file carries, which v3 never wrote', () => {
    const parsed = parseServerConfig(editedServerFile((file) => (file.version = 3)))

    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.config.port).toBeUndefined()
  })

  it('turns a bare boolean coil into an entry, as the current version did', () => {
    const parsed = parseServerConfig(
      editedServerFile((file) => {
        file.version = 3
        file.serverRegistersPerUnit = {
          '0': { ...emptyUnit(), coils: { '4': true } }
        }
      })
    )

    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.config.serverRegistersPerUnit['0']?.coils['4']).toEqual({ value: true })
  })
})

describe('a server config file and its byte swap', () => {
  it('opens with it true from a newer Modbux, whose fields are repaired one by one', () => {
    const parsed = parseServerConfig(
      editedServerFile((file) => {
        file.version = 9
        file.byteSwap = true
      })
    )

    expect(parsed).toMatchObject({ ok: true, config: { byteSwap: true } })
  })

  it('opens without the field, as a file from before byte swap did', () => {
    const parsed = parseServerConfig(editedServerFile((file) => delete file.byteSwap))

    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.config.byteSwap).toBeUndefined()
  })

  it('drops it from a hand-edited v3 file, which v3 never wrote', () => {
    const parsed = parseServerConfig(
      editedServerFile((file) => {
        file.version = 3
        file.byteSwap = true
      })
    )

    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.config.byteSwap).toBeUndefined()
  })

  it('is refused by name when it is not a boolean', () => {
    const parsed = parseServerConfig(editedServerFile((file) => (file.byteSwap = 'yes')))

    expect(parsed).toEqual(byteSwapRefusal)
  })
})

describe('a server config file with a port', () => {
  it('is refused for a port past 65535', () => {
    const parsed = parseServerConfig(editedServerFile((file) => (file.port = 70000)))

    expect(parsed).toEqual({ ok: false, error: expect.stringContaining('port:') })
  })
})

describe('the defaults', () => {
  it('serialize to settings that read back', () => {
    const parsed = parseClientConfig(
      serializeClientConfig({
        ...clientSource(),
        connectionConfig: defaultConnectionConfig,
        registerConfig: defaultRegisterConfig
      })
    )

    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.config.connectionConfig).toEqual(defaultConnectionConfig)
  })
})
