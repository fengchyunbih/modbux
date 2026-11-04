import z, { ZodType, ZodTypeDef } from 'zod'
import { ConnectionConfigSchema, RegisterConfigSchema, RegisterMappingSchema } from './client'
import { PortSchema } from './ranges'
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
 * What `client_connect` did with the request, by what the Connect button would
 * have done with a press.
 *
 * - `requested`: main was asked to connect and has answered; main's client
 *   state says whether it connected.
 * - `not_disconnected`: the client is connected, connecting or disconnecting,
 *   so there was nothing to press.
 * - `no_address`: the host field (TCP) or COM port field (RTU) names nothing,
 *   which is the state the button is greyed in.
 * - `serial_access_blocked`: on Linux, this user may not open serial ports; the
 *   window shows the dialog that fixes it.
 */
export const ClientConnectOutcomeSchema = z.object({
  outcome: z.enum(['requested', 'not_disconnected', 'no_address', 'serial_access_blocked'])
})
export type ClientConnectOutcome = z.infer<typeof ClientConnectOutcomeSchema>

/**
 * What `client_disconnect` did: `requested` once main has answered, or
 * `not_connected` where the client is disconnected or already disconnecting.
 */
export const ClientDisconnectOutcomeSchema = z.object({
  outcome: z.enum(['requested', 'not_connected'])
})
export type ClientDisconnectOutcome = z.infer<typeof ClientDisconnectOutcomeSchema>

//
//
// Config files and servers

/** A config file as text, which is what Save writes and Open reads. */
export const ConfigJsonSchema = z.object({ json: z.string() })
export type ConfigJson = z.infer<typeof ConfigJsonSchema>

/** What a config file import reports besides the result. */
const ImportNotesShape = {
  migrated: z.boolean(),
  fromVersion: z.number(),
  wasMixedEndianness: z.boolean().optional(),
  futureVersion: z
    .object({ fields: z.array(z.string()), savedByNewerVersion: z.boolean() })
    .optional()
}

const ImportFailureSchema = z.object({ ok: z.literal(false), error: z.string() })

/** What `client_import_config` answers: the notes, or why the file was refused. */
export const ClientImportResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), ...ImportNotesShape }),
  ImportFailureSchema
])
export type ClientImportResult = z.infer<typeof ClientImportResultSchema>

/** What `server_import_config` answers. `portRefused` is the port the file asked for and did not get. */
export const ServerImportResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), ...ImportNotesShape, portRefused: z.number().optional() }),
  ImportFailureSchema
])
export type ServerImportResult = z.infer<typeof ServerImportResultSchema>

/** What `project_import` answers. */
export const ProjectImportResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    ...ImportNotesShape,
    portsRefused: z.array(z.number()),
    serversRefused: z.number()
  }),
  ImportFailureSchema
])
export type ProjectImportResult = z.infer<typeof ProjectImportResultSchema>

export const ServerCreateRequestSchema = z.object({
  name: z.string().optional(),
  port: PortSchema.optional()
})
export type ServerCreateRequest = z.infer<typeof ServerCreateRequestSchema>

/** What `server_create` answers: the server made, or why none was. */
export const ServerCreateResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), server: ServerSummarySchema }),
  ImportFailureSchema
])
export type ServerCreateResult = z.infer<typeof ServerCreateResultSchema>

export const ServerUuidRequestSchema = z.object({ uuid: z.string() })
export type ServerUuidRequest = z.infer<typeof ServerUuidRequestSchema>

export const ServerImportRequestSchema = z.object({ uuid: z.string(), json: z.string() })
export type ServerImportRequest = z.infer<typeof ServerImportRequestSchema>

/** What `server_delete` answers. */
export const ServerDeleteResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  ImportFailureSchema
])
export type ServerDeleteResult = z.infer<typeof ServerDeleteResultSchema>

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
  ['client_connect']: { payload: undefined; result: ClientConnectOutcome }
  ['client_disconnect']: { payload: undefined; result: ClientDisconnectOutcome }
  // Config files and servers
  ['client_export_config']: { payload: undefined; result: ConfigJson }
  ['client_import_config']: { payload: ConfigJson; result: ClientImportResult }
  ['server_create']: { payload: ServerCreateRequest; result: ServerCreateResult }
  ['server_delete']: { payload: ServerUuidRequest; result: ServerDeleteResult }
  ['server_export_config']: { payload: ServerUuidRequest; result: ConfigJson }
  ['server_import_config']: { payload: ServerImportRequest; result: ServerImportResult }
  ['project_export']: { payload: undefined; result: ConfigJson }
  ['project_import']: { payload: ConfigJson; result: ProjectImportResult }
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
  server_list: { payload: z.undefined(), result: ServerListSchema },
  client_connect: { payload: z.undefined(), result: ClientConnectOutcomeSchema },
  client_disconnect: { payload: z.undefined(), result: ClientDisconnectOutcomeSchema },
  // Config files and servers
  client_export_config: { payload: z.undefined(), result: ConfigJsonSchema },
  client_import_config: { payload: ConfigJsonSchema, result: ClientImportResultSchema },
  server_create: { payload: ServerCreateRequestSchema, result: ServerCreateResultSchema },
  server_delete: { payload: ServerUuidRequestSchema, result: ServerDeleteResultSchema },
  server_export_config: { payload: ServerUuidRequestSchema, result: ConfigJsonSchema },
  server_import_config: { payload: ServerImportRequestSchema, result: ServerImportResultSchema },
  project_export: { payload: z.undefined(), result: ConfigJsonSchema },
  project_import: { payload: ConfigJsonSchema, result: ProjectImportResultSchema }
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
