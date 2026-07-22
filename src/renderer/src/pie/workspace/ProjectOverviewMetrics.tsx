import type { LucideIcon } from 'lucide-react'
import { Card, CardContent, CardHeader } from '@/components/ui/card'

export function ProjectMetricCard({
  icon: Icon,
  label,
  value,
  detail
}: {
  icon: LucideIcon
  label: string
  value: string
  detail: string
}): React.JSX.Element {
  return (
    <Card className="gap-3 py-4 shadow-xs">
      <CardHeader className="grid-cols-[1fr_auto] px-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {label}
          </p>
          <p className="mt-1 text-2xl font-semibold text-foreground">{value}</p>
        </div>
        <Icon className="size-4 text-muted-foreground" />
      </CardHeader>
      <CardContent className="px-4 text-xs text-muted-foreground">{detail}</CardContent>
    </Card>
  )
}

export function ProjectSummaryRow({
  label,
  value
}: {
  label: string
  value: number
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/50 py-2 last:border-0">
      <span className="text-sm text-foreground">{label}</span>
      <span className="font-mono text-xs text-muted-foreground">{value}</span>
    </div>
  )
}
