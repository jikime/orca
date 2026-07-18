import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { apiPost, resourceEtag, PieApiError } from '../control-plane/pie-api-client'
import { usePieResource } from '../control-plane/use-pie-resource'
import { PieStatusBadge } from './PieStatusBadge'
import type { PieActionSpec, PieDomainConfig, PieFieldSpec } from './pie-domain-registry'

type Row = Record<string, unknown> & { id: string; version?: number; status?: string }

const META_LABEL = 'text-[11px] font-semibold uppercase tracking-wide text-muted-foreground'
const FIELD =
  'w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm shadow-xs transition-[color,box-shadow] focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/50'

function FieldInput({
  field,
  value,
  onChange
}: {
  field: PieFieldSpec
  value: string
  onChange: (v: string) => void
}): React.JSX.Element {
  if (field.type === 'textarea') {
    return (
      <textarea
        className={cn(FIELD, 'min-h-20 resize-y')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }
  if (field.type === 'select') {
    return (
      <select className={FIELD} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {(field.options ?? []).map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    )
  }
  return (
    <Input
      type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

// Coerces a form's string values into the JSON body the API expects (numbers for
// number fields; empty optional fields dropped).
function buildBody(fields: readonly PieFieldSpec[], form: Record<string, string>): unknown {
  const body: Record<string, unknown> = {}
  for (const field of fields) {
    const raw = form[field.key]
    if (raw === undefined || raw === '') {
      continue
    }
    body[field.key] = field.type === 'number' ? Number(raw) : raw
  }
  return body
}

export function PieResourceScreen({ config }: { config: PieDomainConfig }): React.JSX.Element {
  const [projectId, setProjectId] = useState('')
  const [selected, setSelected] = useState<Row | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const listPath = useMemo(() => {
    if (config.scope === 'project') {
      return projectId ? config.listPath.replace('{projectId}', projectId.trim()) : null
    }
    return config.listPath
  }, [config, projectId])

  const list = usePieResource<Record<string, unknown>>(listPath)
  const items = ((list.data?.[config.itemsField ?? 'items'] as Row[]) ?? []).filter(Boolean)

  // Project-scoped domains pick from the org's projects instead of pasting an id.
  const projectsQuery = usePieResource<Record<string, unknown>>(
    config.scope === 'project' ? '/projects' : null
  )
  const projectOptions = (
    (projectsQuery.data?.items as { id: string; name: string }[]) ?? []
  ).filter(Boolean)

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      list.refetch()
      setSelected(null)
    } catch (caught) {
      setError(
        caught instanceof PieApiError
          ? `${caught.code ?? caught.status}: ${caught.message}`
          : String(caught)
      )
    } finally {
      setBusy(false)
    }
  }

  const submitCreate = (): void => {
    if (!config.createPath || !config.createFields) {
      return
    }
    const path =
      config.scope === 'project'
        ? config.createPath.replace('{projectId}', projectId.trim())
        : config.createPath
    void run(async () => {
      await apiPost(path, buildBody(config.createFields!, form))
      setCreating(false)
      setForm({})
    })
  }

  const runAction = (row: Row, action: PieActionSpec): void => {
    const etag =
      action.occ && row.version !== undefined
        ? resourceEtag(config.etagPrefix, row.version)
        : undefined
    void run(() => apiPost(`${config.itemPath(row.id)}:${action.verb}`, action.body, etag))
  }

  const visibleActions = (config.actions ?? []).filter(
    (a) => !a.whenStatus || (selected?.status && a.whenStatus.includes(selected.status))
  )

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold text-foreground">{config.label}</h2>
        {listPath !== null && !list.loading && (
          <Badge variant="secondary" className="rounded-full">
            {items.length}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-2">
          {config.scope === 'project' && (
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="h-8 w-60 rounded-md border border-input bg-background px-2 text-xs shadow-xs focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/50"
            >
              <option value="">
                {projectOptions.length === 0 ? 'No projects — create one first' : 'Select project…'}
              </option>
              {projectOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          {config.createFields && (
            <Button size="sm" onClick={() => setCreating((c) => !c)} disabled={listPath === null}>
              {creating ? 'Cancel' : 'New'}
            </Button>
          )}
        </div>
      </header>

      {error && (
        <div className="border-b border-border bg-destructive/10 px-4 py-2 text-xs font-medium text-destructive">
          {error}
        </div>
      )}

      {creating && config.createFields && (
        <div className="border-b border-border bg-muted/30 px-4 py-3">
          <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
            {config.createFields.map((field) => (
              <label
                key={field.key}
                className={cn('flex flex-col gap-1', field.type === 'textarea' && 'col-span-2')}
              >
                <span className={META_LABEL}>
                  {field.label}
                  {field.required && <span className="text-destructive"> *</span>}
                </span>
                <FieldInput
                  field={field}
                  value={form[field.key] ?? ''}
                  onChange={(v) => setForm((f) => ({ ...f, [field.key]: v }))}
                />
              </label>
            ))}
          </div>
          <div className="mt-3">
            <Button size="sm" onClick={submitCreate} disabled={busy}>
              Create {config.label.replace(/s$/, '')}
            </Button>
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            {listPath === null ? (
              <EmptyState text={`Enter a project id to load ${config.label.toLowerCase()}.`} />
            ) : list.loading ? (
              <EmptyState text="Loading…" />
            ) : items.length === 0 ? (
              <EmptyState text="Nothing here yet." />
            ) : (
              <table className="w-full border-collapse text-[13px]">
                <thead className="sticky top-0 z-10 bg-background/95 backdrop-blur">
                  <tr className="border-b border-border">
                    {config.columns.map((col) => (
                      <th
                        key={col.key}
                        className={cn(META_LABEL, 'px-4 py-2 text-left font-semibold')}
                      >
                        {col.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => (
                    <tr
                      key={row.id}
                      onClick={() => setSelected(row)}
                      data-current={selected?.id === row.id ? 'true' : undefined}
                      className={cn(
                        'cursor-pointer border-b border-border/50 transition-colors hover:bg-accent',
                        selected?.id === row.id && 'bg-accent'
                      )}
                    >
                      {config.columns.map((col, i) => (
                        <td
                          key={col.key}
                          className={cn(
                            'px-4 py-2 align-middle',
                            i === 0 && 'font-medium text-foreground'
                          )}
                        >
                          {col.pill ? (
                            <PieStatusBadge value={row[col.key]} />
                          ) : (
                            <span className={i === 0 ? '' : 'text-muted-foreground'}>
                              {String(row[col.key] ?? '—')}
                            </span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </ScrollArea>
        </div>

        {selected && (
          <aside className="flex w-[22rem] shrink-0 flex-col border-l border-border bg-card">
            <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
              <span className="text-xs font-semibold text-foreground">Details</span>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent"
              >
                Close
              </button>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex flex-col gap-3.5 px-4 py-3.5">
                {(config.detailFields ?? config.columns).map((field) => (
                  <div key={field.key} className="flex flex-col gap-1">
                    <span className={META_LABEL}>{field.label}</span>
                    {/status|severity/i.test(field.key) ? (
                      <PieStatusBadge value={selected[field.key]} />
                    ) : (
                      <span className="text-sm break-words whitespace-pre-wrap text-foreground">
                        {String(selected[field.key] ?? '—')}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </ScrollArea>
            {visibleActions.length > 0 && (
              <div className="flex flex-wrap gap-2 border-t border-border px-4 py-3">
                {visibleActions.map((action) => (
                  <Button
                    key={action.label}
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => runAction(selected, action)}
                  >
                    {action.label}
                  </Button>
                ))}
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  )
}

function EmptyState({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="flex h-40 items-center justify-center px-4 text-sm text-muted-foreground">
      {text}
    </div>
  )
}
