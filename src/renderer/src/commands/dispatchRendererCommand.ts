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
 * A runner that starts each task once the one before it has settled, in the
 * order they were handed over.
 *
 * Commands write through store actions that wait on main, and one undo step
 * snapshots the configuration before it starts: two run at once took the same
 * snapshot, so the first undo put back what was there before both. A task that
 * rejects does not stop the ones after it.
 */
export const createSerialRunner = (): ((task: () => Promise<void>) => Promise<void>) => {
  let tail: Promise<void> = Promise.resolve()
  return (task) => {
    const run = tail.then(task)
    tail = run.catch(() => undefined)
    return run
  }
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
