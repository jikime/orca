import type { PieDomainConfig } from './pie-domain-types'
import { translate } from '@/i18n/i18n'

// Work Portal — governance surfaces: recorded decisions and periodic status reports.
export function buildPiePortalGovernanceDomains(): readonly PieDomainConfig[] {
  return [
    {
      key: 'decisions',
      label: translate('auto.pie.workspace.pie.delivery.domains.9c316a9cc3', 'Decisions'),
      scope: 'project',
      listPath: '/projects/{projectId}/decisions',
      itemPath: (id) => `/decisions/${id}`,
      etagPrefix: 'decision',
      columns: [
        {
          key: 'title',
          label: translate('auto.pie.workspace.pie.delivery.domains.e81fd696ec', 'Title')
        },
        {
          key: 'decidedBy',
          label: translate('auto.pie.workspace.pie.delivery.domains.8825780019', 'Decided by')
        }
      ],
      createPath: '/projects/{projectId}/decisions',
      createFields: [
        {
          key: 'title',
          label: translate('auto.pie.workspace.pie.delivery.domains.e81fd696ec', 'Title'),
          required: true
        },
        {
          key: 'context',
          label: translate('auto.pie.workspace.pie.delivery.domains.ec89029718', 'Context'),
          type: 'textarea'
        },
        {
          key: 'decision',
          label: translate('auto.pie.workspace.pie.delivery.domains.e6e9cf4220', 'Decision'),
          type: 'textarea',
          required: true
        },
        {
          key: 'rationale',
          label: translate('auto.pie.workspace.pie.delivery.domains.ef1d02d24f', 'Rationale'),
          type: 'textarea'
        }
      ],
      detailFields: [
        {
          key: 'title',
          label: translate('auto.pie.workspace.pie.delivery.domains.e81fd696ec', 'Title')
        },
        {
          key: 'context',
          label: translate('auto.pie.workspace.pie.delivery.domains.ec89029718', 'Context')
        },
        {
          key: 'decision',
          label: translate('auto.pie.workspace.pie.delivery.domains.e6e9cf4220', 'Decision')
        },
        {
          key: 'rationale',
          label: translate('auto.pie.workspace.pie.delivery.domains.ef1d02d24f', 'Rationale')
        }
      ]
    },
    {
      key: 'status-reports',
      label: translate('auto.pie.workspace.pie.delivery.domains.6ba70fb787', 'Status Reports'),
      scope: 'project',
      listPath: '/projects/{projectId}/status-reports',
      itemPath: (id) => `/status-reports/${id}`,
      etagPrefix: 'status-report',
      columns: [
        {
          key: 'periodEnd',
          label: translate('auto.pie.workspace.pie.delivery.domains.b920236cd6', 'Period end')
        },
        {
          key: 'overallStatus',
          label: translate('auto.pie.workspace.pie.delivery.domains.5577678c87', 'Status'),
          pill: true
        }
      ],
      createPath: '/projects/{projectId}/status-reports',
      editable: true,
      createFields: [
        {
          key: 'periodStart',
          label: translate('auto.pie.workspace.pie.delivery.domains.03b015adff', 'Period start'),
          type: 'date',
          required: true
        },
        {
          key: 'periodEnd',
          label: translate('auto.pie.workspace.pie.delivery.domains.b920236cd6', 'Period end'),
          type: 'date',
          required: true
        },
        {
          key: 'overallStatus',
          label: translate('auto.pie.workspace.pie.delivery.domains.a7035e605f', 'Overall'),
          type: 'select',
          options: ['green', 'amber', 'red'],
          defaultValue: 'green'
        },
        {
          key: 'summary',
          label: translate('auto.pie.workspace.pie.delivery.domains.856bc71328', 'Summary'),
          type: 'textarea',
          required: true
        },
        {
          key: 'highlights',
          label: translate('auto.pie.workspace.pie.delivery.domains.highlights', 'Highlights'),
          type: 'textarea'
        },
        {
          key: 'risksSummary',
          label: translate('auto.pie.workspace.pie.delivery.domains.risksSummary', 'Risk summary'),
          type: 'textarea'
        },
        {
          key: 'nextSteps',
          label: translate('auto.pie.workspace.pie.delivery.domains.nextSteps', 'Next steps'),
          type: 'textarea'
        }
      ],
      detailFields: [
        {
          key: 'periodEnd',
          label: translate('auto.pie.workspace.pie.delivery.domains.b920236cd6', 'Period end')
        },
        {
          key: 'overallStatus',
          label: translate('auto.pie.workspace.pie.delivery.domains.a7035e605f', 'Overall')
        },
        {
          key: 'summary',
          label: translate('auto.pie.workspace.pie.delivery.domains.856bc71328', 'Summary')
        },
        {
          key: 'highlights',
          label: translate('auto.pie.workspace.pie.delivery.domains.highlights', 'Highlights')
        },
        {
          key: 'risksSummary',
          label: translate('auto.pie.workspace.pie.delivery.domains.risksSummary', 'Risk summary')
        },
        {
          key: 'nextSteps',
          label: translate('auto.pie.workspace.pie.delivery.domains.nextSteps', 'Next steps')
        }
      ]
    }
  ]
}
