// The text Save writes and the result Open reads, without a file and without a
// throw: a refused file answers its reason as a value.
import { describe, expect, it } from 'vitest'
import {
  CURRENT_CLIENT_CONFIG_VERSION,
  CURRENT_SERVER_CONFIG_VERSION,
  emptyRegisterMapping,
  parseClientConfig,
  parseServerConfig,
  serializeClientConfig,
  serializeServerConfig,
  ServerRegisters
} from '@shared'

const clientSource = (): Parameters<typeof serializeClientConfig>[0] => ({
  modbuxVersion: '9.9.9',
  name: 'boiler',
  littleEndian: true,
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
        registers: { '3': unitWithOneRegister() }
      })
    )

    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.migrated).toBe(false)
    expect(parsed.config.version).toBe(CURRENT_SERVER_CONFIG_VERSION)
    expect(parsed.config.name).toBe('meter')
    expect(parsed.config.littleEndian).toBe(true)
    expect(parsed.config.serverRegistersPerUnit['3']).toEqual(unitWithOneRegister())
  })

  it('leaves out a unit that holds nothing', () => {
    const written = JSON.parse(
      serializeServerConfig({
        modbuxVersion: '9.9.9',
        name: 'meter',
        littleEndian: false,
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
