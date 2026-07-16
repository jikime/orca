import type { App, Event } from 'electron'

export type PieProtocolCommandLineResult =
  | { status: 'ambiguous' }
  | { status: 'none' }
  | { status: 'single'; url: string }

export function isPieProtocolUrl(value: string): boolean {
  return /^pie:/i.test(value)
}

export function extractPieProtocolUrl(
  commandLine: readonly string[]
): PieProtocolCommandLineResult {
  const candidates = commandLine.filter(isPieProtocolUrl)
  if (candidates.length === 0) {
    return { status: 'none' }
  }
  if (candidates.length > 1) {
    return { status: 'ambiguous' }
  }
  return { status: 'single', url: candidates[0] }
}

export function registerPieProtocolOpenUrlHandler(
  app: Pick<App, 'off' | 'on'>,
  onUrl: (url: string) => void
): () => void {
  const listener = (event: Event, url: string): void => {
    if (!isPieProtocolUrl(url)) {
      return
    }
    // Why: only Pie-owned URLs are intercepted; unrelated system URL events keep their default behavior.
    event.preventDefault()
    onUrl(url)
  }
  app.on('open-url', listener)
  return () => app.off('open-url', listener)
}
