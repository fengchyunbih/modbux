import {
  RENDERER_COMMAND_SCHEMAS,
  RendererCommandName,
  RendererCommandPayload,
  RendererCommandReply,
  RendererCommandRequestSchema,
  RendererCommandResult,
  formatZodError,
  isRendererCommandName
} from '@shared'

/** One handler per command, taking its parsed payload and answering its result. */
export type RendererCommandHandlers = {
  [N in RendererCommandName]: (
    payload: RendererCommandPayload<N>
  ) => RendererCommandResult<N> | Promise<RendererCommandResult<N>>
}

const run = async <N extends RendererCommandName>(
  name: N,
  payload: unknown,
  handlers: RendererCommandHandlers
): Promise<RendererCommandResult<N>> => {
  const parsed = RENDERER_COMMAND_SCHEMAS[name].payload.safeParse(payload)
  if (!parsed.success) {
    throw new Error(`Invalid payload for ${name}: ${formatZodError(parsed.error)}`)
  }
  return handlers[name](parsed.data)
}

/**
 * Run one `renderer_command` and answer the reply main is waiting for.
 *
 * The payload is parsed against the command's schema before the handler sees
 * it. An unknown name, a payload the schema refuses and a handler that throws
 * each answer `ok: false` with the reason, so main rejects at once rather than
 * at its timeout.
 *
 * A request with no `id` has nobody to answer, and answers `undefined`.
 */
export const dispatchRendererCommand = async (
  request: unknown,
  handlers: RendererCommandHandlers
): Promise<RendererCommandReply | undefined> => {
  const parsed = RendererCommandRequestSchema.safeParse(request)
  if (!parsed.success) return undefined
  const { id, name, payload } = parsed.data

  if (!isRendererCommandName(name)) return { id, ok: false, error: `Unknown command: ${name}` }

  try {
    return { id, ok: true, result: await run(name, payload, handlers) }
  } catch (error) {
    return { id, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
