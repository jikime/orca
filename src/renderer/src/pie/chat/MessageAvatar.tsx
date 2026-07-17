import { cn } from '@/lib/utils'

type MessageAvatarProps = {
  label: string
  size?: 'sm' | 'md'
}

function initials(label: string): string {
  return label === 'You' ? 'Y' : label.slice(0, 2).toUpperCase()
}

// No real per-user identity color (avatar tint, presence) is exposed to the
// renderer, so per STYLEGUIDE ("color for state only") this stays a neutral
// muted circle rather than a fabricated per-user hue.
export function MessageAvatar({ label, size = 'md' }: MessageAvatarProps): React.JSX.Element {
  return (
    <div
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full bg-muted font-medium text-muted-foreground',
        size === 'sm' ? 'size-6 text-[11px]' : 'size-8 text-xs'
      )}
    >
      {initials(label)}
    </div>
  )
}
