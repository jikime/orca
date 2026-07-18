import type { NormalizedImportItem, NormalizedImportKind } from './import-normalized-item'

// R6 slice 6: CSV → normalized import items, so "CSV import" is a real path (Jira/Redmine feed the
// SAME normalized shape after the connector normalizes them upstream). A header row names the
// columns; each subsequent row becomes one NormalizedImportItem. RFC-4180-ish: double-quoted fields
// may contain commas, newlines, and "" escaped quotes.

/** Splits CSV text into rows of raw string cells, honoring quoted fields. */
function tokenizeCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  while (i < text.length) {
    const char = text[i]
    if (inQuotes) {
      if (char === '"') {
        // "" inside a quoted field is a single literal quote.
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      field += char
      i += 1
      continue
    }
    if (char === '"') {
      inQuotes = true
      i += 1
      continue
    }
    if (char === ',') {
      row.push(field)
      field = ''
      i += 1
      continue
    }
    if (char === '\n' || char === '\r') {
      // Close the field/row; swallow a following \n of a \r\n pair.
      row.push(field)
      field = ''
      rows.push(row)
      row = []
      if (char === '\r' && text[i + 1] === '\n') i += 1
      i += 1
      continue
    }
    field += char
    i += 1
  }
  // Flush the trailing field/row when the text does not end in a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function optional(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : null
}

export type CsvParseResult =
  | { ok: true; items: NormalizedImportItem[] }
  | { ok: false; reason: 'empty' | 'missing_columns' | 'invalid_kind'; detail?: string }

const REQUIRED_COLUMNS = ['external_system', 'external_key', 'kind', 'title'] as const
const KINDS: readonly NormalizedImportKind[] = ['project', 'work_item']

/**
 * Parses CSV text into normalized import items. Column order is header-driven (not positional), so a
 * connector can emit columns in any order. Unknown columns are ignored; missing required columns or an
 * unknown `kind` value fail the whole parse (a malformed file is a caller error, not a silent skip).
 */
export function parseCsvImport(csvText: string): CsvParseResult {
  const rows = tokenizeCsv(csvText).filter((r) => !(r.length === 1 && r[0]?.trim() === ''))
  const header = rows[0]
  if (!header) {
    return { ok: false, reason: 'empty' }
  }
  const columns = header.map((c) => c.trim())
  const index = new Map(columns.map((name, i) => [name, i] as const))
  for (const required of REQUIRED_COLUMNS) {
    if (!index.has(required)) {
      return { ok: false, reason: 'missing_columns', detail: required }
    }
  }
  const cell = (cells: string[], name: string): string | undefined => {
    const at = index.get(name)
    return at === undefined ? undefined : cells[at]
  }
  const items: NormalizedImportItem[] = []
  for (const cells of rows.slice(1)) {
    const kindRaw = (cell(cells, 'kind') ?? '').trim()
    if (!KINDS.includes(kindRaw as NormalizedImportKind)) {
      return { ok: false, reason: 'invalid_kind', detail: kindRaw }
    }
    items.push({
      externalSystem: (cell(cells, 'external_system') ?? '').trim(),
      externalKey: (cell(cells, 'external_key') ?? '').trim(),
      kind: kindRaw as NormalizedImportKind,
      title: (cell(cells, 'title') ?? '').trim(),
      summary: optional(cell(cells, 'summary')),
      description: optional(cell(cells, 'description')),
      status: optional(cell(cells, 'status')),
      priority: optional(cell(cells, 'priority')),
      teamId: optional(cell(cells, 'team_id')),
      assigneeEmail: optional(cell(cells, 'assignee_email'))
    })
  }
  return { ok: true, items }
}
