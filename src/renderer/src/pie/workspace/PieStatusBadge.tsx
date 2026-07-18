import { cn } from '@/lib/utils'

// Maps a lifecycle status / severity string to a semantic tone. Semantic colors
// are separate from the app accent (STYLEGUIDE): good = emerald, warn = amber,
// bad = destructive, neutral = muted.
function toneFor(value: string): string {
  const v = value.toLowerCase()
  if (/(reject|fail|overdue|lost|wontfix|critical|red|blocked|missed)/.test(v)) {
    return 'border-destructive/30 bg-destructive/10 text-destructive'
  }
  if (/(approv|paid|accept|active|published|done|met|resolved|closed|green|passed)/.test(v)) {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
  }
  if (
    /(submit|in_review|in_progress|pending|mitigat|in_repair|at_risk|triage|amber|high|partially)/.test(
      v
    )
  ) {
    return 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'
  }
  return 'border-border bg-muted text-muted-foreground'
}

export function PieStatusBadge({ value }: { value: unknown }): React.JSX.Element | null {
  if (value === null || value === undefined || value === '') {
    return null
  }
  const text = String(value).replace(/_/g, ' ')
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold leading-none whitespace-nowrap',
        toneFor(String(value))
      )}
    >
      {text}
    </span>
  )
}
