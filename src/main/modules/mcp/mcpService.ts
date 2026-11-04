import type { Server } from 'http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { MCP_PORT, McpRunState, McpSettings, McpStatus, mcpUrl } from '@shared'
import { closeMcpHttpServer, listenMcpHttpServer, McpRequestHandler } from './httpServer'
import { McpToolContext } from './registry'
import { createMcpServer } from './server'
import { createMcpToken, McpSettingsStore } from './settings'

interface McpServiceParams {
  settings: McpSettingsStore
  /** What the tools reach. The write switch is this service's, so it is not passed. */
  context: Omit<McpToolContext, 'allowWrites'>
  /** The app version the server reports in `initialize`. */
  version: string
  /** Called with the new status on every change to it. */
  onStatus?: (status: McpStatus) => void
  /**
   * The port to listen on. Production passes nothing and gets `MCP_PORT`; the
   * tests pass 0 for a port the kernel picks, so two runs never collide.
   */
  port?: number
  createToken?: () => string
}

/** The text a listen error is shown as, by its `code`. */
const listenFailure = (error: unknown, port: number): string => {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'EADDRINUSE') return `Port ${port} is already in use, so MCP is not running`
  if (code === 'EACCES') return `Port ${port} may not be opened by this user`
  return `MCP did not start: ${error instanceof Error ? error.message : String(error)}`
}

/** A request that is not a POST, which a stateless endpoint has nothing to answer with. */
const methodNotAllowed: McpRequestHandler = async (_request, response) => {
  response.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' }).end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed; this endpoint takes POST only' },
      id: null
    })
  )
}

/**
 * The MCP server's lifecycle: the two switches, the token, and the listener.
 *
 * The endpoint is stateless: every POST gets a fresh `McpServer` and
 * transport, which the SDK requires of a transport without session ids, and
 * nothing outlives the request. No tool here pushes notifications, so a
 * session would hold nothing.
 *
 * Calls that change the listener run one at a time, so a switch flipped twice
 * quickly ends in the state of the second flip.
 */
export class McpService {
  private _settingsStore: McpSettingsStore
  private _settings: McpSettings
  private _context: McpToolContext
  private _version: string
  private _onStatus: (status: McpStatus) => void
  private _port: number
  private _createToken: () => string

  private _server: Server | undefined
  private _state: McpRunState = 'stopped'
  private _error: string | undefined
  private _queue: Promise<unknown> = Promise.resolve()

  constructor({
    settings,
    context,
    version,
    onStatus = (): void => {},
    port = MCP_PORT,
    createToken = createMcpToken
  }: McpServiceParams) {
    this._settingsStore = settings
    this._settings = settings.load()
    this._context = { ...context, allowWrites: (): boolean => this._settings.allowWrites }
    this._version = version
    this._onStatus = onStatus
    this._port = port
    this._createToken = createToken
  }

  /** What the settings page shows. */
  get status(): McpStatus {
    return {
      ...this._settings,
      state: this._state,
      ...(this._error === undefined ? {} : { error: this._error }),
      url: mcpUrl(this.port)
    }
  }

  /** The port listened on, which is the one asked for unless that was 0. */
  get port(): number {
    const address = this._server?.address()
    return typeof address === 'object' && address !== null ? address.port : this._port
  }

  /** Listen if the saved settings say MCP is on. `index.ts` calls this once at startup. */
  public start = (): Promise<McpStatus> => this._serialised(() => this._apply())

  /** Close the listener without touching the settings, for the app quitting. */
  public stop = (): Promise<void> =>
    this._serialised(async () => {
      await this._close()
    })

  public setEnabled = (enabled: boolean): Promise<McpStatus> =>
    this._serialised(() => {
      this._save({ ...this._settings, enabled })
      return this._apply()
    })

  public setAllowWrites = (allowWrites: boolean): McpStatus => {
    this._save({ ...this._settings, allowWrites })
    return this._announce()
  }

  /** A new token, which the next request has to carry. The old one stops working at once. */
  public regenerateToken = (): McpStatus => {
    this._save({ ...this._settings, token: this._createToken() })
    return this._announce()
  }

  private _save(settings: McpSettings): void {
    this._settings = settings
    this._settingsStore.save(settings)
  }

  private _announce(): McpStatus {
    const status = this.status
    this._onStatus(status)
    return status
  }

  private _serialised<T>(task: () => Promise<T>): Promise<T> {
    const run = this._queue.then(task, task)
    this._queue = run.catch(() => undefined)
    return run
  }

  /** Make the listener match `enabled`, and announce the result. */
  private async _apply(): Promise<McpStatus> {
    if (!this._settings.enabled) {
      await this._close()
      this._state = 'stopped'
      this._error = undefined
      return this._announce()
    }
    if (this._server) return this._announce()

    try {
      this._server = await listenMcpHttpServer({
        port: this._port,
        token: () => this._settings.token,
        handle: this._handle
      })
      this._state = 'running'
      this._error = undefined
    } catch (error) {
      this._state = 'error'
      this._error = listenFailure(error, this._port)
    }
    return this._announce()
  }

  private async _close(): Promise<void> {
    const server = this._server
    this._server = undefined
    if (server) await closeMcpHttpServer(server)
  }

  private _handle: McpRequestHandler = async (request, response) => {
    if (request.method !== 'POST') return methodNotAllowed(request, response)

    const server = createMcpServer(this._context, this._version)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    })
    response.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(request, response)
  }
}
