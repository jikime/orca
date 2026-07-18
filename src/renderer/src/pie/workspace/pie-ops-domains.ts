import type { PieDomainConfig } from './pie-domain-types'
import { translate } from '@/i18n/i18n'

// Org-scoped operations surfaces — listed directly (no project selector). Built
// lazily so translate() runs at render time (top-level translate() is disallowed)
// and re-resolves on locale switch.
export function buildPieOpsDomains(): readonly PieDomainConfig[] {
  return [
    {
      key: 'knowledge',
      label: translate('auto.pie.workspace.pie.ops.domains.aff96ed4ff', 'Knowledge Base'),
      scope: 'org',
      listPath: '/knowledge/articles',
      itemPath: (id) => `/knowledge/articles/${id}`,
      etagPrefix: 'knowledge-article',
      columns: [
        {
          key: 'title',
          label: translate('auto.pie.workspace.pie.ops.domains.7558897f37', 'Title')
        },
        {
          key: 'status',
          label: translate('auto.pie.workspace.pie.ops.domains.22916adcef', 'Status'),
          pill: true
        },
        {
          key: 'sourceType',
          label: translate('auto.pie.workspace.pie.ops.domains.66f6a2a799', 'Source')
        },
        {
          key: 'reviewStatus',
          label: translate('auto.pie.workspace.pie.ops.domains.ce0500516c', 'Review'),
          pill: true
        }
      ],
      createPath: '/knowledge/articles',
      createFields: [
        {
          key: 'title',
          label: translate('auto.pie.workspace.pie.ops.domains.7558897f37', 'Title'),
          required: true
        },
        {
          key: 'body',
          label: translate('auto.pie.workspace.pie.ops.domains.9d145af54f', 'Body (markdown)'),
          type: 'textarea',
          required: true
        },
        {
          key: 'visibility',
          label: translate('auto.pie.workspace.pie.ops.domains.dffb733c6e', 'Visibility'),
          type: 'select',
          options: ['internal', 'customer']
        },
        {
          key: 'sourceType',
          label: translate('auto.pie.workspace.pie.ops.domains.66f6a2a799', 'Source'),
          type: 'select',
          options: ['manual', 'ticket', 'remote_session', 'ai']
        }
      ],
      detailFields: [
        {
          key: 'title',
          label: translate('auto.pie.workspace.pie.ops.domains.7558897f37', 'Title')
        },
        { key: 'body', label: translate('auto.pie.workspace.pie.ops.domains.c04cda5c36', 'Body') },
        {
          key: 'status',
          label: translate('auto.pie.workspace.pie.ops.domains.22916adcef', 'Status')
        },
        {
          key: 'reviewStatus',
          label: translate('auto.pie.workspace.pie.ops.domains.9947ed3ef8', 'Review status')
        }
      ],
      actions: [
        {
          label: translate('auto.pie.workspace.pie.ops.domains.0a045d4064', 'Submit for review'),
          verb: 'submit-for-review',
          occ: true,
          whenStatus: ['draft']
        },
        {
          label: translate('auto.pie.workspace.pie.ops.domains.cd4f4f1d0f', 'Publish'),
          verb: 'publish',
          occ: true,
          whenStatus: ['in_review']
        },
        {
          label: translate('auto.pie.workspace.pie.ops.domains.1a20ba7b02', 'Archive'),
          verb: 'archive',
          occ: true
        }
      ]
    },
    {
      key: 'runbooks',
      label: translate('auto.pie.workspace.pie.ops.domains.6859884216', 'Runbooks'),
      scope: 'org',
      listPath: '/runbooks',
      itemPath: (id) => `/runbooks/${id}`,
      etagPrefix: 'runbook',
      columns: [
        { key: 'name', label: translate('auto.pie.workspace.pie.ops.domains.678fbbfce0', 'Name') },
        {
          key: 'targetKind',
          label: translate('auto.pie.workspace.pie.ops.domains.9cae18d8ad', 'Target')
        },
        {
          key: 'requiresApproval',
          label: translate('auto.pie.workspace.pie.ops.domains.52b598b3a0', 'Approval')
        }
      ],
      createPath: '/runbooks',
      createFields: [
        {
          key: 'name',
          label: translate('auto.pie.workspace.pie.ops.domains.678fbbfce0', 'Name'),
          required: true
        },
        {
          key: 'description',
          label: translate('auto.pie.workspace.pie.ops.domains.81fb82367f', 'Description'),
          type: 'textarea'
        },
        {
          key: 'targetKind',
          label: translate('auto.pie.workspace.pie.ops.domains.34b5aa2f05', 'Target kind'),
          type: 'select',
          options: ['project', 'ticket', 'environment']
        }
      ],
      detailFields: [
        { key: 'name', label: translate('auto.pie.workspace.pie.ops.domains.678fbbfce0', 'Name') },
        {
          key: 'description',
          label: translate('auto.pie.workspace.pie.ops.domains.81fb82367f', 'Description')
        },
        {
          key: 'targetKind',
          label: translate('auto.pie.workspace.pie.ops.domains.34b5aa2f05', 'Target kind')
        }
      ]
    },
    {
      key: 'assets',
      label: translate('auto.pie.workspace.pie.ops.domains.89c9540eab', 'Assets'),
      scope: 'org',
      listPath: '/assets',
      itemPath: (id) => `/assets/${id}`,
      etagPrefix: 'asset',
      columns: [
        { key: 'name', label: translate('auto.pie.workspace.pie.ops.domains.678fbbfce0', 'Name') },
        {
          key: 'assetType',
          label: translate('auto.pie.workspace.pie.ops.domains.b8f6d5ef6e', 'Type')
        },
        {
          key: 'status',
          label: translate('auto.pie.workspace.pie.ops.domains.22916adcef', 'Status'),
          pill: true
        }
      ],
      createPath: '/assets',
      createFields: [
        {
          key: 'name',
          label: translate('auto.pie.workspace.pie.ops.domains.678fbbfce0', 'Name'),
          required: true
        },
        {
          key: 'assetType',
          label: translate('auto.pie.workspace.pie.ops.domains.b8f6d5ef6e', 'Type'),
          type: 'select',
          options: ['hardware', 'software', 'license', 'service', 'other']
        },
        {
          key: 'identifier',
          label: translate('auto.pie.workspace.pie.ops.domains.e4c781ff80', 'Serial / tag')
        },
        {
          key: 'vendor',
          label: translate('auto.pie.workspace.pie.ops.domains.48b3df35ec', 'Vendor')
        }
      ],
      detailFields: [
        { key: 'name', label: translate('auto.pie.workspace.pie.ops.domains.678fbbfce0', 'Name') },
        {
          key: 'assetType',
          label: translate('auto.pie.workspace.pie.ops.domains.b8f6d5ef6e', 'Type')
        },
        {
          key: 'identifier',
          label: translate('auto.pie.workspace.pie.ops.domains.e4c781ff80', 'Serial / tag')
        },
        {
          key: 'status',
          label: translate('auto.pie.workspace.pie.ops.domains.22916adcef', 'Status')
        }
      ],
      actions: [
        {
          label: translate('auto.pie.workspace.pie.ops.domains.437df4544e', 'Send to repair'),
          verb: 'transition',
          body: { action: 'repair' },
          occ: true
        },
        {
          label: translate('auto.pie.workspace.pie.ops.domains.d0c35a1071', 'Restore'),
          verb: 'transition',
          body: { action: 'restore' },
          occ: true
        },
        {
          label: translate('auto.pie.workspace.pie.ops.domains.6295d36edc', 'Retire'),
          verb: 'transition',
          body: { action: 'retire' },
          occ: true
        }
      ]
    },
    {
      key: 'invoices',
      label: translate('auto.pie.workspace.pie.ops.domains.c103f6de2b', 'Invoices'),
      scope: 'org',
      listPath: '/invoices',
      itemPath: (id) => `/invoices/${id}`,
      etagPrefix: 'invoice',
      columns: [
        {
          key: 'invoiceNumber',
          label: translate('auto.pie.workspace.pie.ops.domains.73c4426af5', 'Number')
        },
        {
          key: 'status',
          label: translate('auto.pie.workspace.pie.ops.domains.22916adcef', 'Status'),
          pill: true
        },
        {
          key: 'total',
          label: translate('auto.pie.workspace.pie.ops.domains.93e54e9220', 'Total')
        },
        {
          key: 'amountPaid',
          label: translate('auto.pie.workspace.pie.ops.domains.a23ebfc448', 'Paid')
        }
      ],
      createPath: '/invoices',
      createFields: [
        {
          key: 'invoiceNumber',
          label: translate('auto.pie.workspace.pie.ops.domains.d45406d6fb', 'Invoice number'),
          required: true
        },
        {
          key: 'accountId',
          label: translate('auto.pie.workspace.pie.ops.domains.039bef29bf', 'Customer account id'),
          required: true
        },
        {
          key: 'currency',
          label: translate('auto.pie.workspace.pie.ops.domains.5079a679db', 'Currency'),
          type: 'select',
          options: ['KRW', 'USD']
        },
        {
          key: 'taxAmount',
          label: translate('auto.pie.workspace.pie.ops.domains.28c54cd015', 'Tax amount'),
          type: 'number'
        }
      ],
      detailFields: [
        {
          key: 'invoiceNumber',
          label: translate('auto.pie.workspace.pie.ops.domains.73c4426af5', 'Number')
        },
        {
          key: 'status',
          label: translate('auto.pie.workspace.pie.ops.domains.22916adcef', 'Status')
        },
        {
          key: 'subtotal',
          label: translate('auto.pie.workspace.pie.ops.domains.3ec379e60a', 'Subtotal')
        },
        {
          key: 'total',
          label: translate('auto.pie.workspace.pie.ops.domains.93e54e9220', 'Total')
        },
        {
          key: 'amountPaid',
          label: translate('auto.pie.workspace.pie.ops.domains.a23ebfc448', 'Paid')
        }
      ],
      actions: [
        {
          label: translate('auto.pie.workspace.pie.ops.domains.0e17bc6c84', 'Issue'),
          verb: 'issue',
          occ: true,
          whenStatus: ['draft']
        },
        {
          label: translate('auto.pie.workspace.pie.ops.domains.b1d49e5eb4', 'Void'),
          verb: 'void',
          occ: true
        }
      ]
    },
    {
      key: 'meetings',
      label: translate('auto.pie.workspace.pie.ops.domains.0ca0b4a900', 'Meetings'),
      scope: 'org',
      listPath: '/meetings',
      itemPath: (id) => `/meetings/${id}`,
      etagPrefix: 'meeting',
      columns: [
        {
          key: 'title',
          label: translate('auto.pie.workspace.pie.ops.domains.7558897f37', 'Title')
        },
        {
          key: 'status',
          label: translate('auto.pie.workspace.pie.ops.domains.22916adcef', 'Status'),
          pill: true
        },
        {
          key: 'scopeKind',
          label: translate('auto.pie.workspace.pie.ops.domains.6d6f8659b8', 'Scope')
        }
      ],
      createPath: '/meetings',
      createFields: [
        {
          key: 'title',
          label: translate('auto.pie.workspace.pie.ops.domains.7558897f37', 'Title'),
          required: true
        },
        {
          key: 'scopeKind',
          label: translate('auto.pie.workspace.pie.ops.domains.6d6f8659b8', 'Scope'),
          type: 'select',
          options: ['none', 'project', 'ticket']
        },
        {
          key: 'scopeId',
          label: translate('auto.pie.workspace.pie.ops.domains.0c5566b8cf', 'Scope id')
        }
      ],
      detailFields: [
        {
          key: 'title',
          label: translate('auto.pie.workspace.pie.ops.domains.7558897f37', 'Title')
        },
        {
          key: 'status',
          label: translate('auto.pie.workspace.pie.ops.domains.22916adcef', 'Status')
        },
        {
          key: 'scopeKind',
          label: translate('auto.pie.workspace.pie.ops.domains.6d6f8659b8', 'Scope')
        }
      ],
      actions: [
        {
          label: translate('auto.pie.workspace.pie.ops.domains.78422e6236', 'Start'),
          verb: 'transition',
          body: { toStatus: 'live' },
          occ: true,
          whenStatus: ['scheduled']
        },
        {
          label: translate('auto.pie.workspace.pie.ops.domains.c87527c1ec', 'End'),
          verb: 'transition',
          body: { toStatus: 'ended' },
          occ: true,
          whenStatus: ['live']
        }
      ]
    },
    {
      key: 'ai-entitlements',
      label: translate('auto.pie.workspace.pie.ops.domains.c2d496ec71', 'AI Entitlements'),
      scope: 'org',
      listPath: '/ai/entitlements',
      itemPath: (id) => `/ai/entitlements/${id}`,
      etagPrefix: 'ai-entitlement',
      columns: [
        {
          key: 'resourceKey',
          label: translate('auto.pie.workspace.pie.ops.domains.8507ad7924', 'Resource')
        },
        {
          key: 'resourceKind',
          label: translate('auto.pie.workspace.pie.ops.domains.6b7f0bc652', 'Kind')
        },
        {
          key: 'allowed',
          label: translate('auto.pie.workspace.pie.ops.domains.8e8226c6c1', 'Allowed')
        },
        {
          key: 'quotaLimit',
          label: translate('auto.pie.workspace.pie.ops.domains.afddd7551b', 'Quota')
        }
      ],
      createPath: '/ai/entitlements',
      createFields: [
        {
          key: 'resourceKind',
          label: translate('auto.pie.workspace.pie.ops.domains.6b7f0bc652', 'Kind'),
          type: 'select',
          options: ['model', 'tool']
        },
        {
          key: 'resourceKey',
          label: translate('auto.pie.workspace.pie.ops.domains.fc9f0120f9', 'Resource key'),
          required: true
        },
        {
          key: 'quotaLimit',
          label: translate('auto.pie.workspace.pie.ops.domains.cf6eb43198', 'Quota limit'),
          type: 'number'
        },
        {
          key: 'quotaPeriod',
          label: translate('auto.pie.workspace.pie.ops.domains.95a8b8e69d', 'Period'),
          type: 'select',
          options: ['day', 'month', 'total']
        }
      ],
      detailFields: [
        {
          key: 'resourceKey',
          label: translate('auto.pie.workspace.pie.ops.domains.8507ad7924', 'Resource')
        },
        {
          key: 'resourceKind',
          label: translate('auto.pie.workspace.pie.ops.domains.6b7f0bc652', 'Kind')
        },
        {
          key: 'quotaLimit',
          label: translate('auto.pie.workspace.pie.ops.domains.cf6eb43198', 'Quota limit')
        },
        {
          key: 'quotaPeriod',
          label: translate('auto.pie.workspace.pie.ops.domains.95a8b8e69d', 'Period')
        }
      ]
    }
  ]
}
