// Declarative config types for the Pie desktop domain surfaces. One generic
// screen (PieResourceScreen) renders every domain from a PieDomainConfig, so
// adding a backend vertical to the UI is a config entry, not a bespoke screen.

export type PieFieldType = 'text' | 'textarea' | 'number' | 'date' | 'select'

export type PieFieldSpec = {
  key: string
  label: string
  type?: PieFieldType
  options?: readonly string[]
  required?: boolean
}

export type PieColumnSpec = {
  key: string
  label: string
  // Renders a status/severity value as a colored pill when set.
  pill?: boolean
}

export type PieActionSpec = {
  label: string
  // POST to `${itemPath}:${verb}` (colon-suffixed custom method).
  verb: string
  // Exact JSON body — transition verbs differ per domain ({ action } vs
  // { toStatus }); named verbs (approve/issue) usually send nothing.
  body?: Record<string, unknown>
  // Whether the action guards on the row version (OCC If-Match).
  occ?: boolean
  // Only show the action when the row's status is one of these.
  whenStatus?: readonly string[]
}

export type PieDomainConfig = {
  key: string
  label: string
  // 'org' lists directly; 'project' needs a project id chosen first.
  scope: 'org' | 'project'
  // Org-relative list path. For project scope, `{projectId}` is substituted.
  listPath: string
  // Field in the list response that holds the array (default 'items').
  itemsField?: string
  // Org-relative item path builder for detail/actions.
  itemPath: (id: string) => string
  // OCC etag prefix (`"<prefix>-<version>"`) for actions/updates.
  etagPrefix: string
  columns: readonly PieColumnSpec[]
  createPath?: string
  createFields?: readonly PieFieldSpec[]
  detailFields?: readonly PieFieldSpec[]
  actions?: readonly PieActionSpec[]
}
