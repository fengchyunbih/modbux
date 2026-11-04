import z from 'zod'
import { RegisterMapConfigSchema } from './client'
import { ServerConfigSchema, ServerModeSchema, ServerSerialConfigSchema } from './server'

/** The `kind` a project file carries. A client or server config file has none. */
export const PROJECT_KIND = 'project'

/**
 * The version of the project envelope, not of the configs inside it.
 *
 * The embedded client and server configs carry their own versions and are
 * migrated by `migrateClientConfig` and `migrateServerConfig`, so a client
 * v4 does not move this number.
 */
export const CURRENT_PROJECT_VERSION = 1

const ProjectObjectSchema = z.object({
  kind: z.literal(PROJECT_KIND),
  version: z.literal(CURRENT_PROJECT_VERSION),
  modbuxVersion: z.string(),
  client: RegisterMapConfigSchema,
  /** The main server first, then the others in the order they were made. */
  servers: z.array(ServerConfigSchema).min(1),
  /** Index into `servers` of the server the view shows. */
  selectedServer: z.number().int().min(0),
  serverMode: ServerModeSchema,
  serialConfig: ServerSerialConfigSchema
})

/** Fields of the envelope that stay unparsed until each part has been migrated. */
export const ProjectEnvelopeSchema = ProjectObjectSchema.extend({
  client: z.unknown(),
  servers: z.array(z.unknown()).min(1)
})

export const ProjectFileSchema = ProjectObjectSchema.refine(
  (project) => project.selectedServer < project.servers.length,
  { message: 'selectedServer names a server the file does not hold', path: ['selectedServer'] }
)
export type Project = z.infer<typeof ProjectFileSchema>
