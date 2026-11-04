/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFileSettingsStore, createMcpToken } from '../settings'

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'modbux-mcp-settings-'))
  path = join(dir, 'nested', 'mcp.json')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const store = (warn = vi.fn()) =>
  createFileSettingsStore({ path, createToken: () => 'fresh-token', warn })

const onDisk = (): unknown => JSON.parse(readFileSync(path, 'utf-8'))

describe('the MCP settings file', () => {
  it('starts both switches off with a new token, and writes them down', () => {
    expect(store().load()).toEqual({ enabled: false, allowWrites: false, token: 'fresh-token' })
    expect(onDisk()).toEqual({
      version: 1,
      enabled: false,
      allowWrites: false,
      token: 'fresh-token'
    })
  })

  it('reads back what it saved', () => {
    store().save({ enabled: true, allowWrites: true, token: 'kept' })

    expect(store().load()).toEqual({ enabled: true, allowWrites: true, token: 'kept' })
  })

  it.skipIf(process.platform === 'win32')('is readable by its owner alone', () => {
    store().save({ enabled: true, allowWrites: false, token: 'kept' })

    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  // A damaged file can only ever switch MCP off.
  it.each([
    ['text that is not JSON', '{ enabled: true'],
    [
      'a version it does not know',
      JSON.stringify({ version: 2, enabled: true, allowWrites: true, token: 't' })
    ],
    ['an empty token', JSON.stringify({ version: 1, enabled: true, allowWrites: true, token: '' })],
    [
      'a switch that is not a boolean',
      JSON.stringify({ version: 1, enabled: 'yes', allowWrites: false, token: 't' })
    ]
  ])('answers the defaults for %s, says so, and repairs the file', (_name, text) => {
    store().save({ enabled: false, allowWrites: false, token: 'x' })
    writeFileSync(path, text)
    const warn = vi.fn()

    expect(store(warn).load()).toEqual({ enabled: false, allowWrites: false, token: 'fresh-token' })
    expect(warn).toHaveBeenCalledWith(
      `The MCP settings in ${path} were not readable, so MCP starts switched off`
    )
    expect(onDisk()).toMatchObject({ enabled: false, token: 'fresh-token' })
  })

  it('says so when the file cannot be written', () => {
    const warn = vi.fn()
    // A directory where the file should be: the write fails, the load answers.
    const blocked = createFileSettingsStore({ path: dir, createToken: () => 't', warn })

    expect(blocked.load().enabled).toBe(false)
    expect(warn.mock.calls.at(-1)?.[0]).toMatch(/^The MCP settings were not saved to /)
  })
})

describe('createMcpToken', () => {
  it('answers 43 characters of base64url, different every time', () => {
    const first = createMcpToken()

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(createMcpToken()).not.toBe(first)
  })
})
