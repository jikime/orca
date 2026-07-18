import type { PieDomainConfig } from './pie-domain-types'
import { translate } from '@/i18n/i18n'

// Commercial & AI surfaces: invoices, meetings, and AI entitlements.
export function buildPieOpsBillingDomains(): readonly PieDomainConfig[] {
  return [
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
