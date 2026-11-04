import {
  byteOrderFlags,
  byteOrderOf,
  ClientApplyPointTablePayload,
  ClientApplyPointTableResult,
  ClientSetConnectionPayload,
  ClientSetConnectionResult,
  ClientWriteOutcome,
  ConnectionConfig,
  ServerApplyPointTablePayload,
  ServerSetValuesPayload,
  ServerSetValuesResult,
  ServerValues,
  UnitIdStringSchema
} from '@shared'
import { useClientZustand } from '@renderer/context/client.zustand'
import {
  asOneClientStep,
  writeClientConfiguration,
  writeClientSettings
} from '@renderer/context/clientUndo'
import { useServerZustand } from '@renderer/context/server.zustand'
import { asOneServerStep } from '@renderer/context/serverUndo'
import type { RendererCommandHandlers } from './dispatchRendererCommand'

/**
 * The commands the MCP point table tools send, each one written through the
 * store actions an edit goes through and recorded as one undo step
 * (`docs/design/json-config-and-mcp.md`, 架構決策).
 */

type PointTableHandlers = Pick<
  RendererCommandHandlers,
  | 'client_set_connection'
  | 'client_apply_point_table'
  | 'server_apply_point_table'
  | 'server_get_values'
  | 'server_set_values'
>

/** The connection config with the fields `changes` names replaced. */
const mergeConnection = (
  current: ConnectionConfig,
  changes: ClientSetConnectionPayload
): ConnectionConfig => ({
  protocol: changes.protocol ?? current.protocol,
  unitId: changes.unitId ?? current.unitId,
  tcp: {
    host: changes.tcp?.host ?? current.tcp.host,
    options: { port: changes.tcp?.options?.port ?? current.tcp.options.port }
  },
  rtu: {
    com: changes.rtu?.com ?? current.rtu.com,
    options: {
      baudRate: changes.rtu?.options?.baudRate ?? current.rtu.options.baudRate,
      parity: changes.rtu?.options?.parity ?? current.rtu.options.parity,
      dataBits: changes.rtu?.options?.dataBits ?? current.rtu.options.dataBits,
      stopBits: changes.rtu?.options?.stopBits ?? current.rtu.options.stopBits
    }
  }
})

/** Writes the connection fields a client asked for, as one step to undo. */
const clientSetConnection = async (
  changes: ClientSetConnectionPayload
): Promise<ClientSetConnectionResult> => {
  const { connectionConfig, registerConfig } = useClientZustand.getState()
  const target = { connectionConfig: mergeConnection(connectionConfig, changes), registerConfig }
  // Asserted rather than annotated, for the reason `applyClientConfig` gives.
  let outcome = 'refused' as ClientWriteOutcome
  await asOneClientStep(async () => {
    outcome = await writeClientSettings(target)
  })
  return { outcome, connectionConfig: useClientZustand.getState().connectionConfig }
}

/**
 * Replaces the mapping, and sets the read window, the byte order and the unit
 * id the table names, as one step to undo. The name is kept.
 */
const clientApplyPointTable = async ({
  registerMapping,
  window,
  byteOrder,
  unitId
}: ClientApplyPointTablePayload): Promise<ClientApplyPointTableResult> => {
  const { name, connectionConfig, registerConfig } = useClientZustand.getState()
  let outcome = 'refused' as ClientWriteOutcome
  await asOneClientStep(async () => {
    outcome = await writeClientConfiguration({
      name,
      connectionConfig: { ...connectionConfig, unitId: unitId ?? connectionConfig.unitId },
      registerConfig: {
        ...registerConfig,
        ...window,
        ...(byteOrder ? byteOrderFlags(byteOrder) : {})
      },
      registerMapping
    })
  })
  const after = useClientZustand.getState()
  return {
    outcome,
    registerConfig: after.registerConfig,
    unitId: after.connectionConfig.unitId
  }
}

/** Whether the main window's server store is the one to read and write. */
type SplitOutCheck = () => void

/** The server's registers as the store holds them, or a refusal naming the uuid. */
const serverValues = (uuid: string): ServerValues => {
  const server = useServerZustand.getState().servers[uuid]
  if (!server) throw new Error(`No server has uuid ${uuid}`)
  return { uuid, port: server.port, byteOrder: byteOrderOf(server), units: server.registers }
}

/**
 * Replaces the registers of each unit the table names and applies its byte
 * order, on server `uuid`, as one step to undo. The server is selected, and
 * the first unit shown, so the change is on screen.
 */
const serverApplyPointTable = async ({
  uuid,
  units,
  byteOrder
}: ServerApplyPointTablePayload): Promise<ServerValues> => {
  serverValues(uuid)
  if (!useServerZustand.getState().ready[uuid]) {
    throw new Error(`Server ${uuid} is not open in main yet; try again`)
  }
  let wroteBits = false
  await asOneServerStep(
    uuid,
    async () => {
      useServerZustand.getState().setSelectedUuid(uuid)
      const current = useServerZustand.getState().servers[uuid]
      if (byteOrder && current && byteOrderOf(current) !== byteOrder) {
        await useServerZustand.getState().setByteOrder(byteOrder)
      }

      let firstUnit = true
      for (const [key, registers] of Object.entries(units)) {
        if (!registers) continue
        const unitId = UnitIdStringSchema.parse(key)
        await useServerZustand.getState().restoreUnit(uuid, unitId, registers)
        // `restoreUnit` keeps the bit a coil holds now, which is what an undo
        // wants and a table does not, so the table's bits are written after.
        const bits = (['coils', 'discrete_inputs'] as const).flatMap((registerType) =>
          Object.entries(registers[registerType]).map(([address, entry]) => ({
            registerType,
            address: Number(address),
            boolState: entry.value,
            optionalUuid: uuid,
            optionalUnitId: unitId
          }))
        )
        if (bits.length > 0) {
          useServerZustand.getState().setBool(bits)
          wroteBits = true
        }
        if (firstUnit) useServerZustand.getState().setUnitId(unitId)
        firstUnit = false
      }
    },
    () => wroteBits
  )
  return serverValues(uuid)
}

/**
 * Writes raw values into registers a server already holds, as one step to
 * undo. A fixed register gets the value as its params, the way the edit
 * dialog writes one; a generated one is left to its generator.
 */
const serverSetValues = async ({
  uuid,
  values
}: ServerSetValuesPayload): Promise<ServerSetValuesResult> => {
  serverValues(uuid)
  const results: ServerSetValuesResult['results'] = []
  let wroteBits = false
  await asOneServerStep(
    uuid,
    async () => {
      useServerZustand.getState().setSelectedUuid(uuid)
      for (const { unitId, registerType, address, value } of values) {
        const unit = useServerZustand.getState().servers[uuid]?.registers[unitId]
        if (registerType === 'coils' || registerType === 'discrete_inputs') {
          if (!unit?.[registerType][address] || typeof value !== 'boolean') {
            results.push('no_register')
            continue
          }
          useServerZustand.getState().setBool({
            registerType,
            address,
            boolState: value,
            optionalUuid: uuid,
            optionalUnitId: unitId
          })
          wroteBits = true
          results.push('set')
          continue
        }

        const entry = unit?.[registerType][address]
        if (!entry || typeof value === 'boolean') {
          results.push('no_register')
          continue
        }
        if (entry.params.min !== undefined) {
          results.push('generator')
          continue
        }
        const params =
          typeof value === 'string'
            ? { ...entry.params, stringValue: value }
            : { ...entry.params, value }
        const added = await useServerZustand.getState().addRegister({ uuid, unitId, params })
        results.push(added ? 'set' : 'refused')
      }
    },
    () => wroteBits
  )
  return { results }
}

/**
 * The point table handlers. The server ones refuse while the server view is
 * split out, for the reason `server_list` does.
 */
export const createPointTableHandlers = (refuseSplitOut: SplitOutCheck): PointTableHandlers => ({
  client_set_connection: clientSetConnection,
  client_apply_point_table: clientApplyPointTable,
  server_apply_point_table: (payload): Promise<ServerValues> => {
    refuseSplitOut()
    return serverApplyPointTable(payload)
  },
  server_get_values: ({ uuid }): ServerValues => {
    refuseSplitOut()
    return serverValues(uuid)
  },
  server_set_values: (payload): Promise<ServerSetValuesResult> => {
    refuseSplitOut()
    return serverSetValues(payload)
  }
})
