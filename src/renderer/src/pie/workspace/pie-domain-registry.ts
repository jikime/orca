// Declarative config for each Pie desktop domain surface. One generic screen
// (PieResourceScreen) renders every domain from this registry, so adding a
// backend vertical to the UI is a config entry, not a bespoke screen.

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
  // POST to `${itemPath}/:verb`; ':transition' actions send { toStatus }.
  verb: string
  // For a `:transition`, the target status sent as { toStatus }.
  toStatus?: string
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

export const PIE_DOMAINS: readonly PieDomainConfig[] = [
  {
    key: 'change-requests',
    label: 'Change Requests',
    scope: 'project',
    listPath: '/projects/{projectId}/change-requests',
    itemPath: (id) => `/change-requests/${id}`,
    etagPrefix: 'change-request',
    columns: [
      { key: 'title', label: 'Title' },
      { key: 'status', label: 'Status', pill: true },
      { key: 'scheduleDeltaDays', label: 'Δ days' }
    ],
    createPath: '/projects/{projectId}/change-requests',
    createFields: [
      { key: 'title', label: 'Title', required: true },
      { key: 'description', label: 'Description', type: 'textarea' },
      { key: 'scopeDelta', label: 'Scope change', type: 'textarea' },
      { key: 'scheduleDeltaDays', label: 'Schedule Δ (days)', type: 'number' },
      { key: 'costDelta', label: 'Cost Δ', type: 'number' }
    ],
    detailFields: [
      { key: 'title', label: 'Title' },
      { key: 'description', label: 'Description' },
      { key: 'scopeDelta', label: 'Scope change' },
      { key: 'status', label: 'Status' }
    ],
    actions: [
      { label: 'Submit', verb: 'submit-for-approval', occ: true, whenStatus: ['draft'] },
      { label: 'Approve', verb: 'approve', occ: true, whenStatus: ['submitted'] },
      { label: 'Reject', verb: 'reject', occ: true, whenStatus: ['submitted'] },
      { label: 'Apply', verb: 'apply', occ: true, whenStatus: ['approved'] }
    ]
  },
  {
    key: 'knowledge',
    label: 'Knowledge Base',
    scope: 'org',
    listPath: '/knowledge/articles',
    itemPath: (id) => `/knowledge/articles/${id}`,
    etagPrefix: 'knowledge-article',
    columns: [
      { key: 'title', label: 'Title' },
      { key: 'status', label: 'Status', pill: true },
      { key: 'sourceType', label: 'Source' },
      { key: 'reviewStatus', label: 'Review', pill: true }
    ],
    createPath: '/knowledge/articles',
    createFields: [
      { key: 'title', label: 'Title', required: true },
      { key: 'body', label: 'Body (markdown)', type: 'textarea', required: true },
      {
        key: 'visibility',
        label: 'Visibility',
        type: 'select',
        options: ['internal', 'customer']
      },
      {
        key: 'sourceType',
        label: 'Source',
        type: 'select',
        options: ['manual', 'ticket', 'remote_session', 'ai']
      }
    ],
    detailFields: [
      { key: 'title', label: 'Title' },
      { key: 'body', label: 'Body' },
      { key: 'status', label: 'Status' },
      { key: 'reviewStatus', label: 'Review status' }
    ],
    actions: [
      { label: 'Submit for review', verb: 'submit-for-review', occ: true, whenStatus: ['draft'] },
      { label: 'Publish', verb: 'publish', occ: true, whenStatus: ['in_review'] },
      { label: 'Archive', verb: 'archive', occ: true }
    ]
  },
  {
    key: 'runbooks',
    label: 'Runbooks',
    scope: 'org',
    listPath: '/runbooks',
    itemPath: (id) => `/runbooks/${id}`,
    etagPrefix: 'runbook',
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'targetKind', label: 'Target' },
      { key: 'requiresApproval', label: 'Approval' }
    ],
    createPath: '/runbooks',
    createFields: [
      { key: 'name', label: 'Name', required: true },
      { key: 'description', label: 'Description', type: 'textarea' },
      {
        key: 'targetKind',
        label: 'Target kind',
        type: 'select',
        options: ['project', 'ticket', 'environment']
      }
    ],
    detailFields: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'targetKind', label: 'Target kind' }
    ]
  },
  {
    key: 'assets',
    label: 'Assets',
    scope: 'org',
    listPath: '/assets',
    itemPath: (id) => `/assets/${id}`,
    etagPrefix: 'asset',
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'assetType', label: 'Type' },
      { key: 'status', label: 'Status', pill: true }
    ],
    createPath: '/assets',
    createFields: [
      { key: 'name', label: 'Name', required: true },
      {
        key: 'assetType',
        label: 'Type',
        type: 'select',
        options: ['hardware', 'software', 'license', 'service', 'other']
      },
      { key: 'identifier', label: 'Serial / tag' },
      { key: 'vendor', label: 'Vendor' }
    ],
    detailFields: [
      { key: 'name', label: 'Name' },
      { key: 'assetType', label: 'Type' },
      { key: 'identifier', label: 'Serial / tag' },
      { key: 'status', label: 'Status' }
    ],
    actions: [
      { label: 'Send to repair', verb: 'transition', toStatus: 'in_repair', occ: true },
      { label: 'Retire', verb: 'transition', toStatus: 'retired', occ: true }
    ]
  },
  {
    key: 'invoices',
    label: 'Invoices',
    scope: 'org',
    listPath: '/invoices',
    itemPath: (id) => `/invoices/${id}`,
    etagPrefix: 'invoice',
    columns: [
      { key: 'invoiceNumber', label: 'Number' },
      { key: 'status', label: 'Status', pill: true },
      { key: 'total', label: 'Total' },
      { key: 'amountPaid', label: 'Paid' }
    ],
    createPath: '/invoices',
    createFields: [
      { key: 'invoiceNumber', label: 'Invoice number', required: true },
      { key: 'accountId', label: 'Customer account id', required: true },
      { key: 'currency', label: 'Currency', type: 'select', options: ['KRW', 'USD'] },
      { key: 'taxAmount', label: 'Tax amount', type: 'number' }
    ],
    detailFields: [
      { key: 'invoiceNumber', label: 'Number' },
      { key: 'status', label: 'Status' },
      { key: 'subtotal', label: 'Subtotal' },
      { key: 'total', label: 'Total' },
      { key: 'amountPaid', label: 'Paid' }
    ],
    actions: [
      { label: 'Issue', verb: 'issue', occ: true, whenStatus: ['draft'] },
      { label: 'Void', verb: 'void', occ: true }
    ]
  },
  {
    key: 'meetings',
    label: 'Meetings',
    scope: 'org',
    listPath: '/meetings',
    itemPath: (id) => `/meetings/${id}`,
    etagPrefix: 'meeting',
    columns: [
      { key: 'title', label: 'Title' },
      { key: 'status', label: 'Status', pill: true },
      { key: 'scopeKind', label: 'Scope' }
    ],
    createPath: '/meetings',
    createFields: [
      { key: 'title', label: 'Title', required: true },
      { key: 'scopeKind', label: 'Scope', type: 'select', options: ['none', 'project', 'ticket'] },
      { key: 'scopeId', label: 'Scope id' }
    ],
    detailFields: [
      { key: 'title', label: 'Title' },
      { key: 'status', label: 'Status' },
      { key: 'scopeKind', label: 'Scope' }
    ],
    actions: [
      {
        label: 'Start',
        verb: 'transition',
        toStatus: 'live',
        occ: true,
        whenStatus: ['scheduled']
      },
      { label: 'End', verb: 'transition', toStatus: 'ended', occ: true, whenStatus: ['live'] }
    ]
  }
]
