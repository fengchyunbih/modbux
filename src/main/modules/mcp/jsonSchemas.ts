import { ProjectFileSchema, RegisterMapConfigSchema, ServerConfigSchema } from '@shared'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { ZodTypeAny } from 'zod'

/**
 * The JSON Schema of each file Modbux saves, generated from the Zod schema the
 * Open button validates it with, so the two cannot drift.
 *
 * `$refStrategy: 'none'` inlines every definition: a resource is read as one
 * document and has nowhere to resolve a `#/definitions` pointer against.
 * A `refine` on a schema is not expressible and is left out; the app checks
 * it on import.
 */
const toJsonSchema = (schema: ZodTypeAny, title: string): object => ({
  title,
  ...zodToJsonSchema(schema, { $refStrategy: 'none', target: 'jsonSchema7' })
})

export const CLIENT_CONFIG_SCHEMA = toJsonSchema(
  RegisterMapConfigSchema,
  'Modbux client config file'
)
export const SERVER_CONFIG_SCHEMA = toJsonSchema(ServerConfigSchema, 'Modbux server config file')
export const PROJECT_SCHEMA = toJsonSchema(ProjectFileSchema, 'Modbux project file')
