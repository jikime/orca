import { useMemo, useState } from 'react'
import { MessagesSquare, Pencil, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { apiPatch, apiPost, resourceEtag, PieApiError } from '../control-plane/pie-api-client'
import { usePieResource } from '../control-plane/use-pie-resource'
import { PieStatusBadge } from './PieStatusBadge'
import type { PieActionSpec, PieDomainConfig } from './pie-domain-registry'
import { translate } from '@/i18n/i18n'
import { openPieResourceConversation } from './pie-resource-conversation'
import { PieResourceMeetingContext } from './PieResourceMeetingContext'
import { PieResourceMutationDialog } from './PieResourceMutationDialog'

type Row = Record<string, unknown> & { id: string; version?: number; status?: string }

const META_LABEL = 'text-[11px] font-semibold uppercase tracking-wide text-muted-foreground'

export function PieResourceScreen({
  config,
  fixedProjectId
}: {
  config: PieDomainConfig
  fixedProjectId?: string
}): React.JSX.Element {
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [selected, setSelected] = useState<Row | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<Row | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const projectId = fixedProjectId ?? selectedProjectId

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

  const submitCreate = async (body: Record<string, unknown>): Promise<void> => {
    if (!config.createPath || !config.createFields) {
      return
    }
    const path =
      config.scope === 'project'
        ? config.createPath.replace('{projectId}', projectId.trim())
        : config.createPath
    await apiPost(path, body)
    list.refetch()
  }

  const submitEdit = async (body: Record<string, unknown>): Promise<void> => {
    if (!editing || editing.version === undefined) {
      return
    }
    const updated = await apiPatch<Row>(
      config.itemPath(editing.id),
      body,
      resourceEtag(config.etagPrefix, editing.version)
    )
    setSelected(updated)
    list.refetch()
  }

  const runAction = (row: Row, action: PieActionSpec): void => {
    const etag =
      action.occ && row.version !== undefined
        ? resourceEtag(config.etagPrefix, row.version)
        : undefined
    void run(() => apiPost(`${config.itemPath(row.id)}:${action.verb}`, action.body, etag))
  }

  const openContextChannel = async (row: Row): Promise<void> => {
    if (!config.contextChannelScope) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      await openPieResourceConversation({
        scopeType: config.contextChannelScope,
        resourceId: row.id,
        label: String(row.name ?? row.subject ?? config.label)
      })
    } catch (caught) {
      setError(
        caught instanceof PieApiError
          ? `${caught.code ?? caught.status}: ${caught.message}`
          : translate(
              'auto.pie.workspace.PieResourceScreen.chatfailed',
              'Could not open the resource conversation.'
            )
      )
    } finally {
      setBusy(false)
    }
  }

  const visibleActions = (config.actions ?? []).filter(
    (a) => !a.whenStatus || (selected?.status && a.whenStatus.includes(selected.status))
  )
  const itemLabel = config.label.replace(/s$/, '')
  const editFields = config.editFields ?? config.createFields

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
          {config.scope === 'project' && !fixedProjectId && (
            <Select value={projectId || undefined} onValueChange={setSelectedProjectId}>
              <SelectTrigger size="sm" className="w-60">
                <SelectValue
                  placeholder={
                    projectOptions.length === 0
                      ? translate(
                          'auto.pie.workspace.PieResourceScreen.noprojects',
                          'No projects — create one first'
                        )
                      : translate(
                          'auto.pie.workspace.PieResourceScreen.selectproject',
                          'Select project…'
                        )
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {projectOptions.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {config.createFields && (
            <Button size="sm" onClick={() => setCreateOpen(true)} disabled={listPath === null}>
              <Plus />
              {translate('auto.pie.workspace.PieResourceScreen.new', 'New')}
            </Button>
          )}
        </div>
      </header>

      {error && (
        <div className="border-b border-border bg-destructive/10 px-4 py-2 text-xs font-medium text-destructive">
          {error}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            {listPath === null ? (
              <EmptyState
                text={translate(
                  'auto.pie.workspace.PieResourceScreen.10c6f525bc',
                  'Enter a project id to load {{value0}}.',
                  { value0: config.label.toLowerCase() }
                )}
              />
            ) : list.loading ? (
              <EmptyState
                text={translate('auto.pie.workspace.PieResourceScreen.999415bde0', 'Loading…')}
              />
            ) : items.length === 0 ? (
              <EmptyState
                text={translate(
                  'auto.pie.workspace.PieResourceScreen.9d6ab76050',
                  'Nothing here yet.'
                )}
              />
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
              <span className="text-xs font-semibold text-foreground">
                {translate('auto.pie.workspace.PieResourceScreen.c793ddb812', 'Details')}
              </span>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent"
              >
                {translate('auto.pie.workspace.PieResourceScreen.6d663fd51e', 'Close')}
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
            <PieResourceMeetingContext config={config} resource={selected} />
            {(visibleActions.length > 0 || config.contextChannelScope || config.editable) && (
              <div className="flex flex-wrap gap-2 border-t border-border px-4 py-3">
                {config.editable && editFields && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setEditing(selected)}
                  >
                    <Pencil />
                    {translate('auto.pie.workspace.PieResourceScreen.edit', 'Edit')}
                  </Button>
                )}
                {config.contextChannelScope && (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => void openContextChannel(selected)}
                  >
                    <MessagesSquare />
                    {translate(
                      'auto.pie.workspace.PieResourceScreen.openchat',
                      'Open conversation'
                    )}
                  </Button>
                )}
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
      {config.createFields && (
        <PieResourceMutationDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          mode="create"
          itemLabel={itemLabel}
          description={translate(
            'auto.pie.workspace.PieResourceScreen.createDescription',
            'Add a new {{value0}} with the details needed to start tracking it.',
            { value0: itemLabel.toLowerCase() }
          )}
          fields={config.createFields}
          initialValues={null}
          onSubmit={submitCreate}
        />
      )}
      {config.editable && editFields && (
        <PieResourceMutationDialog
          open={editing !== null}
          onOpenChange={(open) => {
            if (!open) {
              setEditing(null)
            }
          }}
          mode="edit"
          itemLabel={itemLabel}
          description={translate(
            'auto.pie.workspace.PieResourceScreen.editDescription',
            'Update this {{value0}} without changing its workflow state.',
            { value0: itemLabel.toLowerCase() }
          )}
          fields={editFields}
          initialValues={editing}
          onSubmit={submitEdit}
        />
      )}
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
