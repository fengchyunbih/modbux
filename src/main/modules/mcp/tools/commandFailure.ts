import { RendererCommandError } from '../../rendererCommands'

/** The message a failed renderer command becomes. */
export const commandFailure = (error: unknown): string => {
  if (error instanceof RendererCommandError) return error.message
  return error instanceof Error ? error.message : String(error)
}
