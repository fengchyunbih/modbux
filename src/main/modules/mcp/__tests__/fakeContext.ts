/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { vi } from 'vitest'
import {
  ClientConfigSnapshot,
  clientOwner,
  ClientState,
  defaultClientState,
  defaultConnectionConfig,
  defaultRegisterConfig,
  emptyRegisterMapping,
  NumberRegisters,
  RegisterMapping
} from '@shared'
import type {
  RawWriteRequest,
  ReadOutcome,
  ScanRegistersOutcome,
  ScanUnitIdsOutcome,
  WriteOutcome
} from '../../modbusClient'
import { McpToolContext } from '../registry'
import { createMcpServer } from '../server'

export const CONFIG: ClientConfigSnapshot = {
  name: 'Meter on the bench',
  connectionConfig: { ...defaultConnectionConfig, unitId: 7 },
  registerConfig: defaultRegisterConfig,
  registerMapping: emptyRegisterMapping(),
  readConfiguration: false
}

/** What a stand-in renderer command answers, by name. */
export type CommandAnswers = Partial<Record<string, (payload: unknown) => Promise<unknown>>>

export interface FakeContext extends McpToolContext {
  /** Set the client state the tools read. */
  setClientState: (state: Partial<ClientState>) => void
  setLastConnectError: (message: string | undefined) => void
  setMainWindowOpen: (open: boolean) => void
  setMapping: (mapping: RegisterMapping) => void
  setReadConfiguration: (on: boolean) => void
  setAllowWrites: (allowed: boolean) => void
  /** Put words in the stand-in server, from `address` on. */
  setServerWords: (
    uuid: string,
    unitId: string,
    registerType: NumberRegisters,
    address: number,
    words: number[]
  ) => void
  read: ReturnType<typeof vi.fn<() => Promise<ReadOutcome>>>
  scanRegisters: ReturnType<typeof vi.fn<McpToolContext['client']['scanRegisters']>>
  scanUnitIds: ReturnType<typeof vi.fn<McpToolContext['client']['scanUnitIds']>>
  stopScanningRegisters: ReturnType<typeof vi.fn<() => void>>
  stopScanningUnitIds: ReturnType<typeof vi.fn<() => void>>
  /** Sets `polling` when the stand-in client is connected and free, as the real one does. */
  startPolling: ReturnType<typeof vi.fn<() => void>>
  stopPollingAndWait: ReturnType<typeof vi.fn<() => Promise<void>>>
  writeRaw: ReturnType<typeof vi.fn<(request: RawWriteRequest) => Promise<WriteOutcome>>>
  send: ReturnType<typeof vi.fn>
}

/**
 * A context whose client and renderer commands are stand-ins.
 *
 * `answers` replaces what a command resolves with; an unnamed command answers
 * `client_get_config`'s snapshot or `{ outcome: 'requested' }`.
 */
export const fakeContext = (answers: CommandAnswers = {}): FakeContext => {
  let clientState: ClientState = { ...defaultClientState }
  let lastConnectError: string | undefined
  let mainWindowOpen = true
  let registerMapping: RegisterMapping | undefined = emptyRegisterMapping()
  let readConfiguration = false
  let allowWrites = false
  // What the stand-in server holds, keyed `uuid/unitId/registerType/address`;
  // an address with no entry reads 0, as the real one does.
  const serverWords = new Map<string, number>()
  const wordKey = (uuid: string, unitId: string, type: string, address: number): string =>
    `${uuid}/${unitId}/${type}/${address}`
  const readRegisters = vi.fn<McpToolContext['server']['readRegisters']>(
    (uuid, unitId, registerType, address, count) =>
      Array.from(
        { length: count },
        (_, offset) => serverWords.get(wordKey(uuid, unitId, registerType, address + offset)) ?? 0
      )
  )
  const registerConfig = { ...defaultRegisterConfig }
  const connectionConfig = { ...defaultConnectionConfig, unitId: 7 }

  const read = vi.fn<() => Promise<ReadOutcome>>(async () => ({
    read: true,
    data: [],
    groups: [],
    errors: []
  }))
  const scanRegisters = vi.fn<McpToolContext['client']['scanRegisters']>(
    async (): Promise<ScanRegistersOutcome> => ({
      scanned: true,
      stopped: false,
      found: [],
      errors: []
    })
  )
  const scanUnitIds = vi.fn<McpToolContext['client']['scanUnitIds']>(
    async (): Promise<ScanUnitIdsOutcome> => ({ scanned: true, stopped: false, results: [] })
  )
  const stopScanningRegisters = vi.fn<() => void>()
  const stopScanningUnitIds = vi.fn<() => void>()
  const startPolling = vi.fn<() => void>(() => {
    if (clientState.connectState === 'connected' && !clientOwner(clientState)) {
      clientState = { ...clientState, polling: true }
    }
  })
  const stopPollingAndWait = vi.fn<() => Promise<void>>(async () => {
    clientState = { ...clientState, polling: false }
  })
  const writeRaw = vi.fn<(request: RawWriteRequest) => Promise<WriteOutcome>>(async () => ({
    written: true
  }))
  const send = vi.fn(async (name: string, payload?: unknown) => {
    const answer = answers[name]
    if (answer) return answer(payload)
    if (name === 'client_get_config') return CONFIG
    return { outcome: 'requested' }
  })

  return {
    client: {
      read,
      scanRegisters,
      scanUnitIds,
      stopScanningRegisters,
      stopScanningUnitIds,
      startPolling,
      stopPollingAndWait,
      writeRaw,
      get state() {
        return clientState
      },
      get lastConnectError() {
        return lastConnectError
      }
    },
    appState: {
      connectionConfig,
      registerConfig,
      get registerMapping() {
        return registerMapping
      },
      get readConfiguration() {
        return readConfiguration
      }
    },
    rendererCommands: { send: send as unknown as McpToolContext['rendererCommands']['send'] },
    server: { readRegisters },
    mainWindowOpen: () => mainWindowOpen,
    allowWrites: () => allowWrites,
    setClientState: (state) => {
      clientState = { ...clientState, ...state }
    },
    setLastConnectError: (message) => {
      lastConnectError = message
    },
    setMainWindowOpen: (open) => {
      mainWindowOpen = open
    },
    setMapping: (mapping) => {
      registerMapping = mapping
    },
    setReadConfiguration: (on) => {
      readConfiguration = on
    },
    setAllowWrites: (allowed) => {
      allowWrites = allowed
    },
    setServerWords: (uuid, unitId, registerType, address, words) => {
      for (const [offset, word] of words.entries()) {
        serverWords.set(wordKey(uuid, unitId, registerType, address + offset), word)
      }
    },
    read,
    scanRegisters,
    scanUnitIds,
    stopScanningRegisters,
    stopScanningUnitIds,
    startPolling,
    stopPollingAndWait,
    writeRaw,
    send
  }
}

/** An SDK client connected in memory to a server answering for `context`. */
export const connectInMemory = async (context: McpToolContext): Promise<Client> => {
  const server = createMcpServer(context, '0.0.0-test')
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

/** The text of a tool result's first content block, or a failure saying there was none. */
export const textOf = (result: unknown): string => {
  const content = (result as CallToolResult).content[0]
  if (content?.type !== 'text') throw new Error('the result has no text content')
  return content.text
}

/** The JSON a tool result carries. */
export const jsonOf = (result: unknown): Record<string, unknown> => JSON.parse(textOf(result))
