import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  CallbackChannelError,
  type CallbackChannel,
  type CallbackOutcome
} from './callback-channel'

// RFC 8252 §7.3 loopback redirect: bind 127.0.0.1 on an ephemeral port, accept a
// single callback, validate the path and state, and respond with a minimal page
// that carries NO token material. The authorization code never appears in the
// page. Single-shot and hard-timed: closes after the first handled hit or timeout.

const CALLBACK_PATH = '/pie-auth/callback'

// A static page — no script, no token/code echoed into the DOM.
const RETURN_TO_APP_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Pie</title></head>
<body style="font-family:system-ui;text-align:center;margin-top:4rem">
<h1>You can return to Pie.</h1><p>This window can be closed.</p>
</body></html>`

export type LoopbackCallbackChannelInput = {
  expectedState: string
  timeoutMs: number
}

function respond(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
  response.end(body)
}

/**
 * Starts the loopback callback server and returns a CallbackChannel. The redirect
 * URI (with the bound port) is only known after listen, so this is async.
 */
export async function startLoopbackCallbackChannel(
  input: LoopbackCallbackChannelInput
): Promise<CallbackChannel> {
  let settle: ((outcome: CallbackOutcome) => void) | null = null
  let fail: ((error: Error) => void) | null = null
  let settled = false
  const promise = new Promise<CallbackOutcome>((resolve, reject) => {
    settle = resolve
    fail = reject
  })

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== CALLBACK_PATH) {
      respond(response, 404, 'not found')
      return
    }
    if (settled) {
      // Single-shot: a second hit never re-delivers a callback.
      respond(response, 409, 'already handled')
      return
    }
    const state = url.searchParams.get('state') ?? ''
    // Reject a mismatched state before anything else — no page, no resolution.
    if (state !== input.expectedState) {
      settled = true
      respond(response, 400, 'invalid request')
      fail?.(new CallbackChannelError('loopback callback state mismatch'))
      return
    }
    settled = true
    const error = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    respond(response, 200, RETURN_TO_APP_PAGE)
    if (error) {
      settle?.({ outcome: 'error', errorCode: error, state })
    } else if (code) {
      settle?.({ outcome: 'success', code, state })
    } else {
      settled = false
      fail?.(new CallbackChannelError('loopback callback missing code'))
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`

  const timer = setTimeout(() => {
    if (!settled) {
      settled = true
      fail?.(new CallbackChannelError('loopback callback timed out'))
    }
  }, input.timeoutMs)
  if (typeof timer === 'object' && 'unref' in timer) {
    timer.unref()
  }

  const close = (): void => {
    clearTimeout(timer)
    server.close()
  }

  return {
    redirectUri,
    waitForCallback: () => promise.finally(close),
    close
  }
}
