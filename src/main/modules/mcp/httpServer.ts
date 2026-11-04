import { timingSafeEqual } from 'crypto'
import { createServer, IncomingMessage, Server, ServerResponse } from 'http'
import { MCP_HOST, MCP_PATH } from '@shared'

/**
 * Whether an `Origin` header names this machine.
 *
 * The MCP transport spec (2025-06-18, "Security Warning") requires a server to
 * validate `Origin`, because a web page the user opens can otherwise reach a
 * server on localhost through the browser. A browser sends the page's origin
 * with every cross-origin request; a CLI client sends none, and an absent
 * header is allowed for that reason. `null` is what a sandboxed page or a
 * `file:` page sends, and it is refused.
 */
export const isLocalOrigin = (origin: string): boolean => {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
}

/** Whether `header` is `Bearer <token>`, compared in constant time. */
export const carriesToken = (header: string | undefined, token: string): boolean => {
  const match = /^Bearer (.+)$/.exec(header ?? '')
  const given = Buffer.from(match?.[1] ?? '')
  const expected = Buffer.from(token)
  // `timingSafeEqual` throws on two lengths, and the length is not the secret.
  return given.length === expected.length && timingSafeEqual(given, expected)
}

const refuse = (response: ServerResponse, status: number, message: string): void => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (status === 401) headers['WWW-Authenticate'] = 'Bearer'
  response
    .writeHead(status, headers)
    .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
}

/** What answers a request that passed every check. */
export type McpRequestHandler = (
  request: IncomingMessage,
  response: ServerResponse
) => Promise<void>

interface McpHttpServerParams {
  port: number
  /** Read per request, so a regenerated token applies to the next one. */
  token: () => string
  handle: McpRequestHandler
  /** Where a handler that threw is reported. */
  onError?: (error: unknown) => void
}

/**
 * The HTTP listener in front of the MCP transport, on `127.0.0.1` alone.
 *
 * Every request is checked in this order: the path, then `Origin`, then the
 * token. A request failing one is answered here and never reaches `handle`.
 *
 * Resolves once the socket is listening and rejects with the listen error,
 * whose `code` is `EADDRINUSE` when the port is taken.
 */
export const listenMcpHttpServer = ({
  port,
  token,
  handle,
  onError = console.error
}: McpHttpServerParams): Promise<Server> => {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    if (path !== MCP_PATH) return refuse(response, 404, `Not found; the endpoint is ${MCP_PATH}`)

    const origin = request.headers.origin
    if (origin !== undefined && !isLocalOrigin(origin)) {
      return refuse(response, 403, `Origin ${origin} is not allowed`)
    }

    if (!carriesToken(request.headers.authorization, token())) {
      return refuse(response, 401, 'Missing or wrong bearer token')
    }

    handle(request, response).catch((error: unknown) => {
      onError(error)
      if (!response.headersSent) refuse(response, 500, 'Internal error')
    })
  })

  return new Promise<Server>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, MCP_HOST, () => {
      server.off('error', reject)
      // An `error` with no listener is thrown, which in main takes the app down.
      server.on('error', onError)
      resolve(server)
    })
  })
}

/** Close the listener and every connection still open on it. */
export const closeMcpHttpServer = (server: Server): Promise<void> =>
  new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })
