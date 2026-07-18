import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { apiPost, resourceEtag, PieApiError } from '../control-plane/pie-api-client'
import { usePieResource } from '../control-plane/use-pie-resource'
import type { PieDomainConfig, PieFieldSpec } from './pie-domain-registry'

type Row = Record<string, unknown> & { id: string; version?: number; status?: string }

function fieldClass(): string {
  return 'w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/50'
}

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
        className={cn(fieldClass(), 'min-h-20 resize-y')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }
  if (field.type === 'select') {
    return (
      <select className={fieldClass()} value={value} onChange={(e) => onChange(e.target.value)}>
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

function StatusPill({ value }: { value: unknown }): React.JSX.Element {
  const text = String(value ?? '')
  const tone = /reject|fail|overdue|lost|critical|red/i.test(text)
    ? 'bg-destructive/15 text-destructive'
    : /approv|paid|accept|active|published|done|green|met/i.test(text)
      ? 'bg-emerald-500/15 text-emerald-600'
      : 'bg-muted text-muted-foreground'
  return (
    <span className={cn('rounded-full px-1.5 py-0.5 text-[11px] font-medium', tone)}>{text}</span>
  )
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

  const runAction = (row: Row, verb: string, toStatus?: string): void => {
    const etag =
      row.version !== undefined ? resourceEtag(config.etagPrefix, row.version) : undefined
    const body = toStatus ? { toStatus } : undefined
    void run(() => apiPost(`${config.itemPath(row.id)}/${verb}`, body, etag))
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold text-foreground">{config.label}</h2>
        <div className="flex items-center gap-2">
          {config.scope === 'project' && (
            <Input
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              placeholder="Project id"
              className="h-8 w-64 text-xs"
            />
          )}
          {config.createFields && (
            <Button size="sm" onClick={() => setCreating((c) => !c)} disabled={listPath === null}>
              {creating ? 'Cancel' : 'New'}
            </Button>
          )}
        </div>
      </div>

      {error && (
        <div className="border-b border-border bg-destructive/10 px-4 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {creating && config.createFields && (
        <div className="flex flex-col gap-2 border-b border-border bg-muted/40 px-4 py-3">
          {config.createFields.map((field) => (
            <label key={field.key} className="flex flex-col gap-1 text-xs text-muted-foreground">
              {field.label}
              {field.required && <span className="sr-only">required</span>}
              <FieldInput
                field={field}
                value={form[field.key] ?? ''}
                onChange={(v) => setForm((f) => ({ ...f, [field.key]: v }))}
              />
            </label>
          ))}
          <div>
            <Button size="sm" onClick={submitCreate} disabled={busy}>
              Create
            </Button>
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <ScrollArea className="min-h-0 flex-1 border-r border-border">
          {listPath === null ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">
              Enter a project id to load {config.label.toLowerCase()}.
            </p>
          ) : list.loading ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">Loading…</p>
          ) : items.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">Nothing here yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-background">
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  {config.columns.map((col) => (
                    <th key={col.key} className="px-4 py-2 font-medium">
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
                    className={cn(
                      'cursor-pointer border-b border-border/60 hover:bg-accent',
                      selected?.id === row.id && 'bg-accent'
                    )}
                  >
                    {config.columns.map((col) => (
                      <td key={col.key} className="px-4 py-2">
                        {col.pill ? (
                          <StatusPill value={row[col.key]} />
                        ) : (
                          <span className="text-foreground">{String(row[col.key] ?? '')}</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </ScrollArea>

        {selected && (
          <div className="flex w-96 shrink-0 flex-col border-l border-border">
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex flex-col gap-3 px-4 py-3">
                {(config.detailFields ?? config.columns).map((field) => (
                  <div key={field.key} className="flex flex-col gap-0.5">
                    <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      {field.label}
                    </span>
                    <span className="text-sm break-words text-foreground">
                      {String(selected[field.key] ?? '—')}
                    </span>
                  </div>
                ))}
              </div>
            </ScrollArea>
            {config.actions && (
              <div className="flex flex-wrap gap-2 border-t border-border px-4 py-3">
                {config.actions
                  .filter(
                    (a) =>
                      !a.whenStatus || (selected.status && a.whenStatus.includes(selected.status))
                  )
                  .map((action) => (
                    <Button
                      key={action.label}
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => runAction(selected, action.verb, action.toStatus)}
                    >
                      {action.label}
                    </Button>
                  ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
