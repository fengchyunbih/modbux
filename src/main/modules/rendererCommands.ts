import { randomUUID } from 'crypto'
import type { WebContents } from 'electron'
import {
  RENDERER_COMMAND_SCHEMAS,
  RendererCommandName,
  RendererCommandPayload,
  RendererCommandReply,
  RendererCommandReplySchema,
  RendererCommandResult,
  formatZodError
} from '@shared'
import { Windows } from '../windows'

/**
 * How long a command waits for the main window, in ms.
 *
 * A command runs store actions that wait on IPC round trips to main, so its
 * answer is a few of those away. A renderer that is loading, reloading or hung
 * never answers, and this is what turns that into an error.
 */
export const RENDERER_COMMAND_TIMEOUT_MS = 10_000

/**
 * Why a command failed.
 *
 * - `no_main_window`: no main window was open to send it to, so nothing ran.
 * - `window_closed`: the main window closed before it answered.
 * - `timeout`: no answer within the timeout. The command may still have run.
 * - `failed`: the renderer answered with an error.
 * - `invalid_result`: the renderer answered something the result schema refuses.
 */
export type RendererCommandErrorCode =
  | 'no_main_window'
  | 'window_closed'
  | 'timeout'
  | 'failed'
  | 'invalid_result'

export class RendererCommandError extends Error {
  readonly code: RendererCommandErrorCode

  constructor(code: RendererCommandErrorCode, message: string) {
    super(message)
    this.name = 'RendererCommandError'
    this.code = code
  }
}

/** The arguments after the name: none for a command whose payload is `undefined`. */
type PayloadArguments<N extends RendererCommandName> =
  undefined extends RendererCommandPayload<N>
    ? [payload?: RendererCommandPayload<N>]
    : [payload: RendererCommandPayload<N>]

interface PendingCommand {
  settle: (reply: RendererCommandReply) => void
  fail: (error: RendererCommandError) => void
}

interface RendererCommandsParams {
  windows: Windows
  timeoutMs?: number
  createId?: () => string
}

/**
 * Commands main sends to the main window's stores, answered by promise.
 *
 * The configuration lives in the renderer's stores and main holds a copy, so a
 * change main wants made is run by the renderer's own store actions and comes
 * back over `renderer_command_result`. Only the main window is asked: the split
 * out server window holds the same stores, and two answers to one command
 * would be two changes.
 *
 * `index.ts` feeds every `renderer_command_result` to `receive`, and calls
 * `abandonAll` when the main window closes.
 */
export class RendererCommands {
  private _windows: Windows
  private _timeoutMs: number
  private _createId: () => string
  private _pending = new Map<string, PendingCommand>()

  constructor({
    windows,
    timeoutMs = RENDERER_COMMAND_TIMEOUT_MS,
    createId = randomUUID
  }: RendererCommandsParams) {
    this._windows = windows
    this._timeoutMs = timeoutMs
    this._createId = createId
  }

  /**
   * Run `name` in the main window, and answer its result once main has parsed
   * it against the command's result schema.
   *
   * Rejects with a `RendererCommandError` whose `code` says why.
   */
  public send = <N extends RendererCommandName>(
    name: N,
    ...[payload]: PayloadArguments<N>
  ): Promise<RendererCommandResult<N>> => {
    const main = this._windows.main
    if (!main || main.isDestroyed()) {
      return Promise.reject(
        new RendererCommandError('no_main_window', `${name}: the main window is not open`)
      )
    }

    const id = this._createId()
    return new Promise<RendererCommandResult<N>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id)
        reject(
          new RendererCommandError(
            'timeout',
            `${name}: the main window did not answer within ${this._timeoutMs} ms`
          )
        )
      }, this._timeoutMs)

      const finish = (): void => {
        clearTimeout(timer)
        this._pending.delete(id)
      }

      this._pending.set(id, {
        settle: (reply) => {
          finish()
          if (!reply.ok) {
            reject(new RendererCommandError('failed', `${name}: ${reply.error}`))
            return
          }
          const parsed = RENDERER_COMMAND_SCHEMAS[name].result.safeParse(reply.result)
          if (!parsed.success) {
            reject(
              new RendererCommandError('invalid_result', `${name}: ${formatZodError(parsed.error)}`)
            )
            return
          }
          resolve(parsed.data)
        },
        fail: (error) => {
          finish()
          reject(error)
        }
      })

      this._windows.send('renderer_command', { id, name, payload }, 'main')
    })
  }

  /**
   * Settle the command a reply names.
   *
   * A reply from any window but the main one is dropped, and so is one that is
   * not a reply or names no command still waiting: a command that timed out
   * has already been answered.
   */
  public receive = (sender: WebContents, reply: unknown): void => {
    if (!this._windows.isMain(sender)) return
    const parsed = RendererCommandReplySchema.safeParse(reply)
    if (!parsed.success) return
    this._pending.get(parsed.data.id)?.settle(parsed.data)
  }

  /** Reject every command still waiting, because the window that would answer is gone. */
  public abandonAll = (): void => {
    for (const pending of [...this._pending.values()]) {
      pending.fail(
        new RendererCommandError('window_closed', 'The main window closed before it answered')
      )
    }
  }

  /** How many commands are waiting for an answer. */
  get pendingCount(): number {
    return this._pending.size
  }
}
