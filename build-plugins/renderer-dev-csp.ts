import type { Plugin } from 'vite'

// Why: src/renderer/index.html ships a strict production Content-Security-Policy
// (ELC-005 hardening) meant for the file:// production renderer. The electron-vite
// dev server serves the renderer over http://localhost with HMR over a websocket,
// and @vitejs/plugin-react injects an inline module preamble — all of which the
// production policy blocks. This serve-only plugin rewrites the CSP tag to add
// the dev origins and the inline/eval the dev toolchain needs, so 'unsafe-eval'
// never has to live in the committed production tag.

const DEV_CSP = [
  "default-src 'self'",
  // Vite injects an inline React-refresh preamble and serves modules from the
  // dev origin; HMR tooling may eval in dev only.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' http://localhost:* https://localhost:*",
  "style-src 'self' 'unsafe-inline' http://localhost:* https://localhost:*",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob: data: https: http://127.0.0.1:* http://[::1]:*",
  "worker-src 'self' blob:",
  // Vite uses localhost; local meeting signaling and validation use loopback IPs.
  "connect-src 'self' wss: https: ws://localhost:* wss://localhost:* http://localhost:* https://localhost:* ws://127.0.0.1:* ws://[::1]:* http://127.0.0.1:* http://[::1]:*",
  "object-src 'none'",
  "base-uri 'none'"
].join('; ')

const CSP_META_RE = /<meta\s+http-equiv=["']Content-Security-Policy["'][\s\S]*?\/>/i

export function createRendererDevCspPlugin(): Plugin {
  return {
    name: 'orca-renderer-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(
        CSP_META_RE,
        `<meta http-equiv="Content-Security-Policy" content="${DEV_CSP}" />`
      )
    }
  }
}
