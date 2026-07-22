import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { PieApiError } from '../control-plane/pie-api-client'
import type { PieFieldSpec } from './pie-domain-types'

type MutationMode = 'create' | 'edit'

function initialForm(
  fields: readonly PieFieldSpec[],
  values: Record<string, unknown> | null
): Record<string, string> {
  return Object.fromEntries(
    fields.map((field) => {
      const value = values?.[field.key]
      return [
        field.key,
        value === null || value === undefined ? (field.defaultValue ?? '') : String(value)
      ]
    })
  )
}

export function buildPieMutationBody(
  fields: readonly PieFieldSpec[],
  form: Record<string, string>,
  mode: MutationMode
): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const field of fields) {
    const raw = form[field.key]?.trim() ?? ''
    if (!raw) {
      if (mode === 'edit' && !field.required) {
        body[field.key] = null
      }
      continue
    }
    body[field.key] = field.type === 'number' ? Number(raw) : raw
  }
  return body
}

function mutationError(caught: unknown): string {
  return caught instanceof PieApiError
    ? `${caught.code ?? caught.status}: ${caught.message}`
    : caught instanceof Error
      ? caught.message
      : String(caught)
}

function MutationField({
  field,
  value,
  inputId,
  autoFocus,
  onChange
}: {
  field: PieFieldSpec
  value: string
  inputId: string
  autoFocus: boolean
  onChange: (value: string) => void
}): React.JSX.Element {
  if (field.type === 'textarea') {
    return (
      <Textarea
        id={inputId}
        value={value}
        required={field.required}
        maxLength={field.maxLength}
        autoFocus={autoFocus}
        className="min-h-24 resize-y"
        onChange={(event) => onChange(event.target.value)}
      />
    )
  }
  if (field.type === 'select') {
    return (
      <Select value={value || undefined} onValueChange={onChange}>
        <SelectTrigger id={inputId} className="w-full">
          <SelectValue
            placeholder={translate(
              'auto.pie.workspace.PieResourceMutationDialog.select',
              'Select…'
            )}
          />
        </SelectTrigger>
        <SelectContent>
          {(field.options ?? []).map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }
  return (
    <Input
      id={inputId}
      type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
      value={value}
      required={field.required}
      maxLength={field.maxLength}
      autoFocus={autoFocus}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

function PieResourceMutationDialogSession({
  open,
  onOpenChange,
  mode,
  itemLabel,
  description,
  fields,
  initialValues,
  onSubmit
}: PieResourceMutationDialogProps): React.JSX.Element {
  const formId = useId()
  const [form, setForm] = useState(() => initialForm(fields, initialValues))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const valid = fields.every((field) => !field.required || Boolean(form[field.key]?.trim()))
  const wide = fields.length > 4 || fields.filter((field) => field.type === 'textarea').length > 1

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!valid || busy) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSubmit(buildPieMutationBody(fields, form, mode))
      onOpenChange(false)
    } catch (caught) {
      setError(mutationError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent
        className={cn('max-h-[85vh] overflow-y-auto scrollbar-sleek', wide && 'sm:max-w-2xl')}
      >
        <DialogHeader>
          <DialogTitle>
            {mode === 'create'
              ? translate(
                  'auto.pie.workspace.PieResourceMutationDialog.createTitle',
                  'Create {{value0}}',
                  { value0: itemLabel }
                )
              : translate(
                  'auto.pie.workspace.PieResourceMutationDialog.editTitle',
                  'Edit {{value0}}',
                  { value0: itemLabel }
                )}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form id={formId} className="space-y-4" onSubmit={(event) => void submit(event)}>
          <div className={cn('grid grid-cols-1 gap-4', wide && 'sm:grid-cols-2')}>
            {fields.map((field, index) => {
              const inputId = `${formId}-${field.key}`
              return (
                <div
                  key={field.key}
                  className={cn('space-y-2', wide && field.type === 'textarea' && 'sm:col-span-2')}
                >
                  <Label htmlFor={inputId}>
                    {field.label}
                    {field.required && <span className="text-destructive"> *</span>}
                  </Label>
                  <MutationField
                    field={field}
                    value={form[field.key] ?? ''}
                    inputId={inputId}
                    autoFocus={index === 0}
                    onChange={(value) => setForm((current) => ({ ...current, [field.key]: value }))}
                  />
                </div>
              )
            })}
          </div>
          {error && <p className="text-sm font-medium text-destructive">{error}</p>}
        </form>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            {translate('auto.pie.workspace.PieResourceMutationDialog.cancel', 'Cancel')}
          </Button>
          <Button type="submit" form={formId} disabled={busy || !valid}>
            {busy
              ? mode === 'create'
                ? translate('auto.pie.workspace.PieResourceMutationDialog.creating', 'Creating…')
                : translate('auto.pie.workspace.PieResourceMutationDialog.saving', 'Saving…')
              : mode === 'create'
                ? translate('auto.pie.workspace.PieResourceMutationDialog.create', 'Create')
                : translate('auto.pie.workspace.PieResourceMutationDialog.save', 'Save changes')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export type PieResourceMutationDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: MutationMode
  itemLabel: string
  description: string
  fields: readonly PieFieldSpec[]
  initialValues: Record<string, unknown> | null
  onSubmit: (body: Record<string, unknown>) => Promise<void>
}

export function PieResourceMutationDialog(
  props: PieResourceMutationDialogProps
): React.JSX.Element {
  // Why: opening a different record must start with its own immutable snapshot;
  // stale form fields or mutation errors must never carry between records.
  const identity = props.initialValues?.id ?? 'new'
  return (
    <PieResourceMutationDialogSession
      key={`${props.mode}:${String(identity)}:${props.open ? 'open' : 'closed'}`}
      {...props}
    />
  )
}
