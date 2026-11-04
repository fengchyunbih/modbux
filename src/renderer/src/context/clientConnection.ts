import { ClientConnectOutcome, ClientDisconnectOutcome } from '@shared'
import { useSerialGroupZustand } from '@renderer/components/client/SerialGroupModal/serialGroupModal.zustand'
import { useClientZustand } from './client.zustand'
import { useDataZustand } from './data.zustand'

/**
 * Connect and Disconnect for the client, without the button.
 *
 * The Connect button calls these two, and so do the `client_connect` and
 * `client_disconnect` commands from main, so a connect asked for over MCP ends
 * where a press would have left the window.
 */

/**
 * Ask main to connect, and resolve once it has answered.
 *
 * Main's client state is what says whether it connected; this says whether it
 * was asked. A field that names nothing is the state the button is greyed in,
 * so a press never reaches that branch and a command does.
 */
export const connectClient = async (): Promise<ClientConnectOutcome> => {
  if (useDataZustand.getState().clientState.connectState !== 'disconnected') {
    return { outcome: 'not_disconnected' }
  }

  const { connectionConfig, valid } = useClientZustand.getState()
  const rtu = connectionConfig.protocol === 'ModbusRtu'
  if (!(rtu ? valid.com : valid.host)) return { outcome: 'no_address' }

  // On RTU the port can be there and still refuse to open. Ask first and
  // say why, rather than let the connect fail on a permission error.
  if (rtu) {
    const blocked = await useSerialGroupZustand.getState().check({ force: true })
    if (blocked) return { outcome: 'serial_access_blocked' }
  }

  await window.api.connect()
  return { outcome: 'requested' }
}

/**
 * Ask main to disconnect, or to cancel a connect still opening, and resolve
 * once it has answered.
 *
 * The grid is emptied as the request goes out, unless read configuration is on.
 */
export const disconnectClient = async (): Promise<ClientDisconnectOutcome> => {
  const connectState = useDataZustand.getState().clientState.connectState
  if (connectState !== 'connected' && connectState !== 'connecting') {
    return { outcome: 'not_connected' }
  }

  const disconnecting = window.api.disconnect()
  if (!useClientZustand.getState().readConfiguration) {
    useDataZustand.getState().setRegisterData([])
  }
  await disconnecting
  return { outcome: 'requested' }
}
