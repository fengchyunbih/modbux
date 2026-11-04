// A store written before byte swap existed carries no `byteSwap`, and the
// schema that reads it back requires one. The step gives it the `false` such a
// store means, so nothing is reported reset.
import { describe, expect, it } from 'vitest'
import { CURRENT_CLIENT_ZUSTAND_VERSION, migrateClientState } from '../client/zustand'
import { CURRENT_SERVER_ZUSTAND_VERSION, migrateServerState } from '../server/zustand'
import { defaultRegisterConfig } from '../../default'
import { RegisterConfigSchema } from '../../types/client'

/** The register config a v3 client store wrote, every field but the new one. */
const v3RegisterConfig = (): Record<string, unknown> => {
  const registerConfig: Record<string, unknown> = { ...defaultRegisterConfig, littleEndian: true }
  delete registerConfig.byteSwap
  return registerConfig
}

describe('the client store step to v4', () => {
  it('is the current version', () => {
    expect(CURRENT_CLIENT_ZUSTAND_VERSION).toBe(4)
  })

  it('gives a v3 register config the byte swap it means, and keeps the rest', () => {
    const state = migrateClientState({ registerConfig: v3RegisterConfig() }, 3)

    expect(state.registerConfig).toEqual({ ...v3RegisterConfig(), byteSwap: false })
    expect(RegisterConfigSchema.safeParse(state.registerConfig).success).toBe(true)
  })

  it('keeps a byte swap the blob already carries', () => {
    const state = migrateClientState(
      { registerConfig: { ...v3RegisterConfig(), byteSwap: true } },
      3
    )

    expect(state.registerConfig).toMatchObject({ byteSwap: true })
  })

  it('leaves a register config that is not an object for the repair to report', () => {
    expect(migrateClientState({ registerConfig: 'nope' }, 3).registerConfig).toBe('nope')
  })

  it('adds nothing to a blob at the current version', () => {
    const state = migrateClientState(
      { registerConfig: v3RegisterConfig() },
      CURRENT_CLIENT_ZUSTAND_VERSION
    )

    expect(state.registerConfig).not.toHaveProperty('byteSwap')
  })
})

describe('the server store step to v5', () => {
  const v4Server = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    port: '502',
    unitId: '0',
    littleEndian: true,
    registers: {},
    usedAddresses: {},
    ...extra
  })

  it('is the current version', () => {
    expect(CURRENT_SERVER_ZUSTAND_VERSION).toBe(5)
  })

  it('gives every v4 server the byte swap it means, and keeps one it carries', () => {
    const state = migrateServerState(
      {
        selectedUuid: 'a',
        servers: { a: v4Server(), b: v4Server({ byteSwap: true }) }
      },
      4
    )

    expect(state.servers).toEqual({
      a: v4Server({ byteSwap: false }),
      b: v4Server({ byteSwap: true })
    })
  })

  it('adds nothing to a blob at the current version', () => {
    const state = migrateServerState(
      { selectedUuid: 'a', servers: { a: v4Server() } },
      CURRENT_SERVER_ZUSTAND_VERSION
    )

    expect((state.servers as Record<string, object>).a).not.toHaveProperty('byteSwap')
  })
})
