import { cn } from '@/lib/utils'

// Highlights @mention and #channel tokens in the plain-text body. The backend
// stores mentions out-of-band (user ids), so this is presentational only —
// matching the visible @label the composer inserted.
const TOKEN = /(^|\s)([@#][\p{L}\p{N}._-]+)/gu

export function MessageBody({ body }: { body: string }): React.JSX.Element {
  const parts: React.ReactNode[] = []
  let lastIndex = 0
  for (const match of body.matchAll(TOKEN)) {
    const start = (match.index ?? 0) + match[1].length
    if (start > lastIndex) {
      parts.push(body.slice(lastIndex, start))
    }
    parts.push(
      <span
        key={start}
        className={cn(
          'rounded px-0.5',
          match[2].startsWith('@') ? 'bg-primary/10 text-primary' : 'text-primary'
        )}
      >
        {match[2]}
      </span>
    )
    lastIndex = start + match[2].length
  }
  if (lastIndex < body.length) {
    parts.push(body.slice(lastIndex))
  }
  return <>{parts}</>
}
