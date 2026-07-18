import type { PieDomainConfig } from './pie-domain-types'

// Project-scoped delivery/governance surfaces — each needs a project id chosen
// first, then lists that project's records.
export const PIE_DELIVERY_DOMAINS: readonly PieDomainConfig[] = [
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
    key: 'deliverables',
    label: 'Deliverables',
    scope: 'project',
    listPath: '/projects/{projectId}/deliverables',
    itemPath: (id) => `/deliverables/${id}`,
    etagPrefix: 'deliverable',
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'status', label: 'Status', pill: true },
      { key: 'dueDate', label: 'Due' }
    ],
    createPath: '/projects/{projectId}/deliverables',
    createFields: [
      { key: 'name', label: 'Name', required: true },
      { key: 'description', label: 'Description', type: 'textarea' },
      { key: 'requirementId', label: 'Requirement id' },
      { key: 'dueDate', label: 'Due date', type: 'date' }
    ],
    detailFields: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'status', label: 'Status' }
    ],
    actions: [
      { label: 'Submit', verb: 'transition', body: { action: 'submit' }, occ: true },
      { label: 'Accept', verb: 'transition', body: { action: 'accept' }, occ: true },
      { label: 'Reject', verb: 'transition', body: { action: 'reject' }, occ: true }
    ]
  },
  {
    key: 'defects',
    label: 'Defects',
    scope: 'project',
    listPath: '/projects/{projectId}/defects',
    itemPath: (id) => `/defects/${id}`,
    etagPrefix: 'defect',
    columns: [
      { key: 'title', label: 'Title' },
      { key: 'severity', label: 'Severity', pill: true },
      { key: 'status', label: 'Status', pill: true }
    ],
    createPath: '/projects/{projectId}/defects',
    createFields: [
      { key: 'title', label: 'Title', required: true },
      { key: 'description', label: 'Description', type: 'textarea' },
      {
        key: 'severity',
        label: 'Severity',
        type: 'select',
        options: ['low', 'medium', 'high', 'critical']
      }
    ],
    detailFields: [
      { key: 'title', label: 'Title' },
      { key: 'description', label: 'Description' },
      { key: 'severity', label: 'Severity' },
      { key: 'status', label: 'Status' }
    ],
    actions: [
      { label: 'Triage', verb: 'transition', body: { action: 'triage' }, occ: true },
      { label: 'Resolve', verb: 'transition', body: { action: 'resolve' }, occ: true },
      { label: 'Close', verb: 'transition', body: { action: 'close' }, occ: true }
    ]
  },
  {
    key: 'risks',
    label: 'Project Risks',
    scope: 'project',
    listPath: '/projects/{projectId}/risks',
    itemPath: (id) => `/risks/${id}`,
    etagPrefix: 'risk',
    columns: [
      { key: 'title', label: 'Title' },
      { key: 'severity', label: 'Severity', pill: true },
      { key: 'status', label: 'Status', pill: true }
    ],
    createPath: '/projects/{projectId}/risks',
    createFields: [
      { key: 'title', label: 'Title', required: true },
      { key: 'description', label: 'Description', type: 'textarea' },
      {
        key: 'category',
        label: 'Category',
        type: 'select',
        options: ['schedule', 'budget', 'technical', 'resource', 'external']
      },
      {
        key: 'probability',
        label: 'Probability',
        type: 'select',
        options: ['low', 'medium', 'high']
      },
      { key: 'impact', label: 'Impact', type: 'select', options: ['low', 'medium', 'high'] },
      { key: 'mitigation', label: 'Mitigation', type: 'textarea' }
    ],
    detailFields: [
      { key: 'title', label: 'Title' },
      { key: 'severity', label: 'Severity' },
      { key: 'mitigation', label: 'Mitigation' },
      { key: 'status', label: 'Status' }
    ],
    actions: [
      { label: 'Mitigate', verb: 'transition', body: { action: 'mitigate' }, occ: true },
      { label: 'Close', verb: 'transition', body: { action: 'close' }, occ: true },
      { label: 'Accept', verb: 'transition', body: { action: 'accept' }, occ: true }
    ]
  },
  {
    key: 'decisions',
    label: 'Decisions',
    scope: 'project',
    listPath: '/projects/{projectId}/decisions',
    itemPath: (id) => `/decisions/${id}`,
    etagPrefix: 'decision',
    columns: [
      { key: 'title', label: 'Title' },
      { key: 'decidedBy', label: 'Decided by' }
    ],
    createPath: '/projects/{projectId}/decisions',
    createFields: [
      { key: 'title', label: 'Title', required: true },
      { key: 'context', label: 'Context', type: 'textarea' },
      { key: 'decision', label: 'Decision', type: 'textarea', required: true },
      { key: 'rationale', label: 'Rationale', type: 'textarea' }
    ],
    detailFields: [
      { key: 'title', label: 'Title' },
      { key: 'context', label: 'Context' },
      { key: 'decision', label: 'Decision' },
      { key: 'rationale', label: 'Rationale' }
    ]
  },
  {
    key: 'status-reports',
    label: 'Status Reports',
    scope: 'project',
    listPath: '/projects/{projectId}/status-reports',
    itemPath: (id) => `/status-reports/${id}`,
    etagPrefix: 'status-report',
    columns: [
      { key: 'periodEnd', label: 'Period end' },
      { key: 'overallStatus', label: 'Status', pill: true }
    ],
    createPath: '/projects/{projectId}/status-reports',
    createFields: [
      { key: 'periodStart', label: 'Period start', type: 'date' },
      { key: 'periodEnd', label: 'Period end', type: 'date', required: true },
      {
        key: 'overallStatus',
        label: 'Overall',
        type: 'select',
        options: ['green', 'amber', 'red']
      },
      { key: 'summary', label: 'Summary', type: 'textarea', required: true }
    ],
    detailFields: [
      { key: 'periodEnd', label: 'Period end' },
      { key: 'overallStatus', label: 'Overall' },
      { key: 'summary', label: 'Summary' }
    ]
  }
]
