// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/explicit-function-return-type */
//
// Connect and Disconnect as the button and the `client_connect` and
// `client_disconnect` commands run them. A command reaches these with no
// button greyed in front of it, so the states the button cannot be pressed in
// are answered here.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientState, defaultClientState, RegisterData } from '@shared'
import { recordApiCalls, stubRenderer, type ApiCall } from './stubRenderer'

vi.mock('notistack', () => ({ enqueueSnackbar: vi.fn() }))

const ROW: RegisterData = {
  id: 0,
  buffer: new Uint8Array(2),
  hex: '0000',
  words: undefined,
  bit: false,
  isScanned: false
}

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  stubRenderer()
})

/** The modules under test, with the client in `connectState` and a row in the grid. */
const load = async (connectState: ClientState['connectState']) => {
  const { connectClient, disconnectClient } = await import('../clientConnection')
  const { useClientZustand } = await import('../client.zustand')
  const { useDataZustand } = await import('../data.zustand')
  const { useSerialGroupZustand } =
    await import('@renderer/components/client/SerialGroupModal/serialGroupModal.zustand')
  useDataZustand.setState({
    clientState: { ...defaultClientState, connectState },
    registerData: [ROW]
  })
  const calls: ApiCall[] = []
  recordApiCalls(calls)
  const methods = (): string[] => calls.map((call) => call.method)
  return {
    connectClient,
    disconnectClient,
    useClientZustand,
    useDataZustand,
    useSerialGroupZustand,
    methods
  }
}

describe('connectClient', () => {
  it('asks main to connect from disconnected', async () => {
    const { connectClient, methods } = await load('disconnected')

    expect(await connectClient()).toEqual({ outcome: 'requested' })
    expect(methods()).toEqual(['connect'])
  })

  it.each(['connected', 'connecting', 'disconnecting'] as const)(
    'asks nothing while %s',
    async (connectState) => {
      const { connectClient, methods } = await load(connectState)

      expect(await connectClient()).toEqual({ outcome: 'not_disconnected' })
      expect(methods()).toEqual([])
    }
  )

  it('asks nothing while the host names nothing on TCP', async () => {
    const { connectClient, useClientZustand, methods } = await load('disconnected')
    useClientZustand.setState((state) => {
      state.valid.host = false
    })

    expect(await connectClient()).toEqual({ outcome: 'no_address' })
    expect(methods()).toEqual([])
  })

  // The COM field is the RTU one, and a blank host is beside the point there.
  it('connects on RTU while the host names nothing', async () => {
    const { connectClient, useClientZustand, useSerialGroupZustand, methods } =
      await load('disconnected')
    useSerialGroupZustand.setState({ check: async () => false })
    useClientZustand.setState((state) => {
      state.connectionConfig.protocol = 'ModbusRtu'
      state.valid.host = false
    })

    expect(await connectClient()).toEqual({ outcome: 'requested' })
    expect(methods()).toEqual(['connect'])
  })

  it('asks nothing on RTU while the serial group is in the way', async () => {
    const { connectClient, useClientZustand, useSerialGroupZustand, methods } =
      await load('disconnected')
    useSerialGroupZustand.setState({ check: async () => true })
    useClientZustand.setState((state) => {
      state.connectionConfig.protocol = 'ModbusRtu'
    })

    expect(await connectClient()).toEqual({ outcome: 'serial_access_blocked' })
    expect(methods()).toEqual([])
  })
})

describe('disconnectClient', () => {
  it.each(['connected', 'connecting'] as const)(
    'asks main to disconnect while %s and empties the grid',
    async (connectState) => {
      const { disconnectClient, useDataZustand, methods } = await load(connectState)

      expect(await disconnectClient()).toEqual({ outcome: 'requested' })
      expect(methods()).toEqual(['disconnect'])
      expect(useDataZustand.getState().registerData).toEqual([])
    }
  )

  it('keeps the grid under read configuration', async () => {
    const { disconnectClient, useClientZustand, useDataZustand } = await load('connected')
    useClientZustand.setState({ readConfiguration: true })

    await disconnectClient()

    expect(useDataZustand.getState().registerData).toEqual([ROW])
  })

  it.each(['disconnected', 'disconnecting'] as const)(
    'asks nothing while %s',
    async (connectState) => {
      const { disconnectClient, useDataZustand, methods } = await load(connectState)

      expect(await disconnectClient()).toEqual({ outcome: 'not_connected' })
      expect(methods()).toEqual([])
      expect(useDataZustand.getState().registerData).toEqual([ROW])
    }
  )
})
