import { useEffect, useRef, type RefObject } from 'react'

// Slack-style composers grow with content instead of scrolling inside a fixed
// box; capping the height keeps a very long paste from pushing the toolbar
// and Send button off-screen.
const MAX_TEXTAREA_HEIGHT_PX = 160

// Shared by ChannelComposer and MessageComposer so both auto-grow identically
// (STYLEGUIDE "look for sibling components" — adjacent composers read as one).
export function useComposerTextareaAutogrow(value: string): RefObject<HTMLTextAreaElement | null> {
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) {
      return
    }
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)}px`
  }, [value])

  return ref
}
