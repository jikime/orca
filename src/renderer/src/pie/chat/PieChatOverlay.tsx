import { useEffect, useState } from 'react'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { PieWorkspace } from '../workspace/PieWorkspace'

// Least-invasive mount for the Pie chat surface. It is self-contained: a single
// <PieChatOverlay /> in App renders nothing until toggled, so normal Orca use is
// undisturbed. Dev-gated (or VITE_ENABLE_PIE_CHAT) so it ships dark by default.
//
// Open/close: Cmd+Shift+K on macOS, Ctrl+Shift+K on Linux/Windows; Esc closes.
export function isPieChatOverlayEnabled(env: ImportMetaEnv = import.meta.env): boolean {
  return env.DEV || env.VITE_ENABLE_PIE_CHAT === 'true'
}

function isToggleChord(event: KeyboardEvent): boolean {
  const primary = getShortcutPlatform() === 'darwin' ? event.metaKey : event.ctrlKey
  return primary && event.shiftKey && event.key.toLowerCase() === 'k'
}

export function PieChatOverlay(): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const enabled = isPieChatOverlayEnabled()

  useEffect(() => {
    if (!enabled) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isToggleChord(event)) {
        event.preventDefault()
        setOpen((current) => !current)
        return
      }
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled])

  if (!enabled || !open) {
    return null
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background"
      role="dialog"
      aria-label="Pie workspace"
    >
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="text-xs font-medium text-muted-foreground">Pie workspace</span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close Pie workspace"
          className="rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          Close (Esc)
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <PieWorkspace />
      </div>
    </div>
  )
}
