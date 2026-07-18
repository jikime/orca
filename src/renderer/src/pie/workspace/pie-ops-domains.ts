import type { PieDomainConfig } from './pie-domain-types'

// Org-scoped operations surfaces — listed directly (no project selector).
export const PIE_OPS_DOMAINS: readonly PieDomainConfig[] = [
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
      { key: 'visibility', label: 'Visibility', type: 'select', options: ['internal', 'customer'] },
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
      { label: 'Send to repair', verb: 'transition', body: { action: 'repair' }, occ: true },
      { label: 'Restore', verb: 'transition', body: { action: 'restore' }, occ: true },
      { label: 'Retire', verb: 'transition', body: { action: 'retire' }, occ: true }
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
        body: { toStatus: 'live' },
        occ: true,
        whenStatus: ['scheduled']
      },
      {
        label: 'End',
        verb: 'transition',
        body: { toStatus: 'ended' },
        occ: true,
        whenStatus: ['live']
      }
    ]
  },
  {
    key: 'ai-entitlements',
    label: 'AI Entitlements',
    scope: 'org',
    listPath: '/ai/entitlements',
    itemPath: (id) => `/ai/entitlements/${id}`,
    etagPrefix: 'ai-entitlement',
    columns: [
      { key: 'resourceKey', label: 'Resource' },
      { key: 'resourceKind', label: 'Kind' },
      { key: 'allowed', label: 'Allowed' },
      { key: 'quotaLimit', label: 'Quota' }
    ],
    createPath: '/ai/entitlements',
    createFields: [
      { key: 'resourceKind', label: 'Kind', type: 'select', options: ['model', 'tool'] },
      { key: 'resourceKey', label: 'Resource key', required: true },
      { key: 'quotaLimit', label: 'Quota limit', type: 'number' },
      { key: 'quotaPeriod', label: 'Period', type: 'select', options: ['day', 'month', 'total'] }
    ],
    detailFields: [
      { key: 'resourceKey', label: 'Resource' },
      { key: 'resourceKind', label: 'Kind' },
      { key: 'quotaLimit', label: 'Quota limit' },
      { key: 'quotaPeriod', label: 'Period' }
    ]
  }
]
