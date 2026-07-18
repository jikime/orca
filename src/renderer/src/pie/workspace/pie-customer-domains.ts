import type { PieDomainConfig } from './pie-domain-types'
import { translate } from '@/i18n/i18n'

// Customer module: accounts, their contracts, and issued invoices.
export function buildPieCustomerDomains(): readonly PieDomainConfig[] {
  return [
    {
      key: 'accounts',
      label: translate('auto.pie.customer.domains.accounts', 'Accounts'),
      scope: 'org',
      listPath: '/crm/accounts',
      itemPath: (id) => `/crm/accounts/${id}`,
      etagPrefix: 'crm-account',
      columns: [
        { key: 'name', label: translate('auto.pie.customer.domains.name', 'Name') },
        {
          key: 'status',
          label: translate('auto.pie.customer.domains.status', 'Status'),
          pill: true
        }
      ],
      createPath: '/crm/accounts',
      createFields: [
        { key: 'name', label: translate('auto.pie.customer.domains.name', 'Name'), required: true },
        {
          key: 'status',
          label: translate('auto.pie.customer.domains.status', 'Status'),
          type: 'select',
          options: ['prospect', 'active', 'inactive']
        },
        {
          key: 'externalRef',
          label: translate('auto.pie.customer.domains.externalref', 'External ref')
        }
      ],
      detailFields: [
        { key: 'name', label: translate('auto.pie.customer.domains.name', 'Name') },
        { key: 'status', label: translate('auto.pie.customer.domains.status', 'Status') },
        { key: 'id', label: translate('auto.pie.customer.domains.accountid', 'Account id') }
      ]
    },
    {
      key: 'contracts',
      label: translate('auto.pie.customer.domains.contracts', 'Contracts'),
      scope: 'org',
      listPath: '/crm/contracts',
      itemPath: (id) => `/crm/contracts/${id}`,
      etagPrefix: 'crm-contract',
      columns: [
        { key: 'title', label: translate('auto.pie.customer.domains.title', 'Title') },
        {
          key: 'status',
          label: translate('auto.pie.customer.domains.status', 'Status'),
          pill: true
        },
        { key: 'contractValue', label: translate('auto.pie.customer.domains.value', 'Value') }
      ],
      createPath: '/crm/contracts',
      createFields: [
        {
          key: 'accountId',
          label: translate('auto.pie.customer.domains.accountid', 'Account id'),
          required: true
        },
        {
          key: 'title',
          label: translate('auto.pie.customer.domains.title', 'Title'),
          required: true
        },
        {
          key: 'contractValue',
          label: translate('auto.pie.customer.domains.value', 'Contract value'),
          type: 'number'
        },
        {
          key: 'effectiveStart',
          label: translate('auto.pie.customer.domains.start', 'Effective start'),
          type: 'date'
        },
        {
          key: 'effectiveEnd',
          label: translate('auto.pie.customer.domains.end', 'Effective end'),
          type: 'date'
        }
      ],
      detailFields: [
        { key: 'title', label: translate('auto.pie.customer.domains.title', 'Title') },
        { key: 'status', label: translate('auto.pie.customer.domains.status', 'Status') },
        { key: 'contractValue', label: translate('auto.pie.customer.domains.value', 'Value') }
      ],
      actions: [
        {
          label: translate('auto.pie.customer.domains.submit', 'Submit'),
          verb: 'submit-for-approval',
          occ: true
        },
        {
          label: translate('auto.pie.customer.domains.approve', 'Approve'),
          verb: 'approve',
          occ: true
        },
        {
          label: translate('auto.pie.customer.domains.reject', 'Reject'),
          verb: 'reject',
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
    }
  ]
}
