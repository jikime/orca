import type {
  PieRuntimeHandshakeResponse,
  PieRuntimeRendererApi
} from '../../../shared/pie-runtime-handshake-contract'
import type { PieSessionRendererApi, PieSessionState } from '../../../shared/pie-session-contract'

export type PieDesktopBootstrapResult = {
  session: PieSessionState
  runtime: PieRuntimeHandshakeResponse
}

type PieDesktopBoundaryApi = {
  session: PieSessionRendererApi
  runtime: PieRuntimeRendererApi
}

let defaultBootstrapPromise: Promise<PieDesktopBootstrapResult> | null = null

async function readPieDesktopBoundary(
  api: PieDesktopBoundaryApi
): Promise<PieDesktopBootstrapResult> {
  const [session, runtime] = await Promise.all([api.session.getState(), api.runtime.getHandshake()])
  return { runtime, session }
}

export function bootstrapPieDesktopBoundary(
  api?: PieDesktopBoundaryApi
): Promise<PieDesktopBootstrapResult> {
  if (api) {
    return readPieDesktopBoundary(api)
  }
  // Why: React StrictMode mounts startup effects twice in development. The
  // security probe should establish one logical Main/Runtime handshake.
  defaultBootstrapPromise ??= readPieDesktopBoundary(window.api.pie)
  return defaultBootstrapPromise
}
