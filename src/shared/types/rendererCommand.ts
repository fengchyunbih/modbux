import z, { ZodType, ZodTypeDef } from 'zod'
import { ConnectionConfigSchema, RegisterConfigSchema, RegisterMappingSchema } from './client'
import { UnitIdStringSchema } from './unitid'

//
//
// Commands main sends to the main window's renderer
//
// The configuration lives in the renderer's stores, and main holds a copy the
// renderer pushes. A change main wants made, which is what an MCP tool asks
// for, is therefore sent to the main window as a command, run there by the
// store's own actions, and answered back. `renderer_command` carries the
// request and `renderer_command_result` the reply, matched on `id`.

/** What `client_get_config` answers: the client store's configuration. */
export const ClientConfigSnapshotSchema = z.object({
  name: z.string(),
  connectionConfig: ConnectionConfigSchema,
  registerConfig: RegisterConfigSchema,
  registerMapping: RegisterMappingSchema,
  readConfiguration: z.boolean()
})
export type ClientConfigSnapshot = z.infer<typeof ClientConfigSnapshotSchema>

/** One server as `server_list` answers it, with the port as the store holds it. */
export const ServerSummarySchema = z.object({
  uuid: z.string(),
  name: z.string().optional(),
  port: z.string(),
  unitId: UnitIdStringSchema
})
export type ServerSummary = z.infer<typeof ServerSummarySchema>

/** What `server_list` answers: every server, in the order the store made them. */
export const ServerListSchema = z.object({
  selectedUuid: z.string(),
  servers: z.array(ServerSummarySchema)
})
export type ServerList = z.infer<typeof ServerListSchema>

/**
 * Every command, with what it takes and what it answers.
 *
 * The keys are the command names. A command that takes nothing declares
 * `payload: undefined`, and `RendererCommands.send` then takes no second
 * argument.
 */
export interface RendererCommandMap {
  ['client_get_config']: { payload: undefined; result: ClientConfigSnapshot }
  ['server_list']: { payload: undefined; result: ServerList }
}

export type RendererCommandName = keyof RendererCommandMap
export type RendererCommandPayload<N extends RendererCommandName> = RendererCommandMap[N]['payload']
export type RendererCommandResult<N extends RendererCommandName> = RendererCommandMap[N]['result']

/**
 * A schema whose output is `T`, whatever it takes as input.
 *
 * `ZodType<T>` alone fixes the input to `T` as well, which a schema with a
 * default or a transform does not satisfy.
 */
type SchemaOf<T> = ZodType<T, ZodTypeDef, unknown>

/**
 * The payload and result schema of every command.
 *
 * The renderer parses a payload before its handler sees it, and main parses a
 * result before its caller does: both arrive over IPC. The mapped type makes
 * a command in `RendererCommandMap` without an entry here a type error.
 */
export const RENDERER_COMMAND_SCHEMAS: {
  [N in RendererCommandName]: {
    payload: SchemaOf<RendererCommandPayload<N>>
    result: SchemaOf<RendererCommandResult<N>>
  }
} = {
  client_get_config: { payload: z.undefined(), result: ClientConfigSnapshotSchema },
  server_list: { payload: z.undefined(), result: ServerListSchema }
}

/** Whether `name` is a command, which a request off the wire has to be asked. */
export const isRendererCommandName = (name: string): name is RendererCommandName =>
  Object.prototype.hasOwnProperty.call(RENDERER_COMMAND_SCHEMAS, name)

/** What `renderer_command` carries to the main window. */
export const RendererCommandRequestSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  payload: z.unknown()
})
export type RendererCommandRequest = z.infer<typeof RendererCommandRequestSchema>

/**
 * What `renderer_command_result` carries back to main.
 *
 * `result` is checked against the command's own schema by main, which is the
 * side that knows which command the `id` was.
 */
export const RendererCommandReplySchema = z.discriminatedUnion('ok', [
  z.object({ id: z.string().min(1), ok: z.literal(true), result: z.unknown() }),
  z.object({ id: z.string().min(1), ok: z.literal(false), error: z.string() })
])
export type RendererCommandReply = z.infer<typeof RendererCommandReplySchema>
