import type { PieDomainConfig } from './pie-domain-types'
import { translate } from '@/i18n/i18n'

// Project-scoped delivery/governance surfaces — each needs a project id chosen
// first, then lists that project's records. Built lazily so translate() runs at
// render time (top-level translate() is disallowed) and re-resolves on locale switch.
export function buildPieDeliveryDomains(): readonly PieDomainConfig[] {
  return [
    {
      key: 'projects',
      label: translate('auto.pie.workspace.pie.delivery.domains.0d3345601f', 'Projects'),
      scope: 'org',
      listPath: '/projects',
      itemPath: (id) => `/projects/${id}`,
      etagPrefix: 'project',
      columns: [
        {
          key: 'name',
          label: translate('auto.pie.workspace.pie.delivery.domains.bb0c1e914c', 'Name')
        },
        {
          key: 'status',
          label: translate('auto.pie.workspace.pie.delivery.domains.5577678c87', 'Status'),
          pill: true
        },
        {
          key: 'id',
          label: translate('auto.pie.workspace.pie.delivery.domains.f6f2ed2887', 'Project id')
        }
      ],
      createPath: '/projects',
      createFields: [
        {
          key: 'name',
          label: translate('auto.pie.workspace.pie.delivery.domains.bb0c1e914c', 'Name'),
          required: true
        },
        {
          key: 'summary',
          label: translate('auto.pie.workspace.pie.delivery.domains.856bc71328', 'Summary'),
          type: 'textarea'
        }
      ],
      detailFields: [
        {
          key: 'name',
          label: translate('auto.pie.workspace.pie.delivery.domains.bb0c1e914c', 'Name')
        },
        {
          key: 'summary',
          label: translate('auto.pie.workspace.pie.delivery.domains.856bc71328', 'Summary')
        },
        {
          key: 'status',
          label: translate('auto.pie.workspace.pie.delivery.domains.5577678c87', 'Status')
        },
        {
          key: 'id',
          label: translate('auto.pie.workspace.pie.delivery.domains.f6f2ed2887', 'Project id')
        }
      ]
    },
    {
      key: 'change-requests',
      label: translate('auto.pie.workspace.pie.delivery.domains.39a3a89e8b', 'Change Requests'),
      scope: 'project',
      listPath: '/projects/{projectId}/change-requests',
      itemPath: (id) => `/change-requests/${id}`,
      etagPrefix: 'change-request',
      columns: [
        {
          key: 'title',
          label: translate('auto.pie.workspace.pie.delivery.domains.e81fd696ec', 'Title')
        },
        {
          key: 'status',
          label: translate('auto.pie.workspace.pie.delivery.domains.5577678c87', 'Status'),
          pill: true
        },
        {
          key: 'scheduleDeltaDays',
          label: translate('auto.pie.workspace.pie.delivery.domains.61bfd56903', 'Δ days')
        }
      ],
      createPath: '/projects/{projectId}/change-requests',
      createFields: [
        {
          key: 'title',
          label: translate('auto.pie.workspace.pie.delivery.domains.e81fd696ec', 'Title'),
          required: true
        },
        {
          key: 'description',
          label: translate('auto.pie.workspace.pie.delivery.domains.f31f87fec9', 'Description'),
          type: 'textarea'
        },
        {
          key: 'scopeDelta',
          label: translate('auto.pie.workspace.pie.delivery.domains.59cbef5216', 'Scope change'),
          type: 'textarea'
        },
        {
          key: 'scheduleDeltaDays',
          label: translate(
            'auto.pie.workspace.pie.delivery.domains.2cef9c56b0',
            'Schedule Δ (days)'
          ),
          type: 'number'
        },
        {
          key: 'costDelta',
          label: translate('auto.pie.workspace.pie.delivery.domains.f110aadd65', 'Cost Δ'),
          type: 'number'
        }
      ],
      detailFields: [
        {
          key: 'title',
          label: translate('auto.pie.workspace.pie.delivery.domains.e81fd696ec', 'Title')
        },
        {
          key: 'description',
          label: translate('auto.pie.workspace.pie.delivery.domains.f31f87fec9', 'Description')
        },
        {
          key: 'scopeDelta',
          label: translate('auto.pie.workspace.pie.delivery.domains.59cbef5216', 'Scope change')
        },
        {
          key: 'status',
          label: translate('auto.pie.workspace.pie.delivery.domains.5577678c87', 'Status')
        }
      ],
      actions: [
        {
          label: translate('auto.pie.workspace.pie.delivery.domains.f813ae200a', 'Submit'),
          verb: 'submit-for-approval',
          occ: true,
          whenStatus: ['draft']
        },
        {
          label: translate('auto.pie.workspace.pie.delivery.domains.d27db98c62', 'Approve'),
          verb: 'approve',
          occ: true,
          whenStatus: ['submitted']
        },
        {
          label: translate('auto.pie.workspace.pie.delivery.domains.78766269bb', 'Reject'),
          verb: 'reject',
          occ: true,
          whenStatus: ['submitted']
        },
        {
          label: translate('auto.pie.workspace.pie.delivery.domains.0f06b726df', 'Apply'),
          verb: 'apply',
          occ: true,
          whenStatus: ['approved']
        }
      ]
    },
    {
      key: 'deliverables',
      label: translate('auto.pie.workspace.pie.delivery.domains.8f07e74824', 'Deliverables'),
      scope: 'project',
      listPath: '/projects/{projectId}/deliverables',
      itemPath: (id) => `/deliverables/${id}`,
      etagPrefix: 'deliverable',
      columns: [
        {
          key: 'name',
          label: translate('auto.pie.workspace.pie.delivery.domains.bb0c1e914c', 'Name')
        },
        {
          key: 'status',
          label: translate('auto.pie.workspace.pie.delivery.domains.5577678c87', 'Status'),
          pill: true
        },
        {
          key: 'dueDate',
          label: translate('auto.pie.workspace.pie.delivery.domains.b1541ca4f2', 'Due')
        }
      ],
      createPath: '/projects/{projectId}/deliverables',
      createFields: [
        {
          key: 'name',
          label: translate('auto.pie.workspace.pie.delivery.domains.bb0c1e914c', 'Name'),
          required: true
        },
        {
          key: 'description',
          label: translate('auto.pie.workspace.pie.delivery.domains.f31f87fec9', 'Description'),
          type: 'textarea'
        },
        {
          key: 'requirementId',
          label: translate('auto.pie.workspace.pie.delivery.domains.8aa8226f51', 'Requirement id')
        },
        {
          key: 'dueDate',
          label: translate('auto.pie.workspace.pie.delivery.domains.b7c66fb7d9', 'Due date'),
          type: 'date'
        }
      ],
      detailFields: [
        {
          key: 'name',
          label: translate('auto.pie.workspace.pie.delivery.domains.bb0c1e914c', 'Name')
        },
        {
          key: 'description',
          label: translate('auto.pie.workspace.pie.delivery.domains.f31f87fec9', 'Description')
        },
        {
          key: 'status',
          label: translate('auto.pie.workspace.pie.delivery.domains.5577678c87', 'Status')
        }
      ],
      actions: [
        {
          label: translate('auto.pie.workspace.pie.delivery.domains.f813ae200a', 'Submit'),
          verb: 'transition',
          body: { action: 'submit' },
          occ: true
        },
        {
          label: translate('auto.pie.workspace.pie.delivery.domains.9622b7c6fa', 'Accept'),
          verb: 'transition',
          body: { action: 'accept' },
          occ: true
        },
        {
          label: translate('auto.pie.workspace.pie.delivery.domains.78766269bb', 'Reject'),
          verb: 'transition',
          body: { action: 'reject' },
          occ: true
        }
      ]
    },
    {
      key: 'defects',
      label: translate('auto.pie.workspace.pie.delivery.domains.01821240ba', 'Defects'),
      scope: 'project',
      listPath: '/projects/{projectId}/defects',
      itemPath: (id) => `/defects/${id}`,
      etagPrefix: 'defect',
      columns: [
        {
          key: 'title',
          label: translate('auto.pie.workspace.pie.delivery.domains.e81fd696ec', 'Title')
        },
        {
          key: 'severity',
          label: translate('auto.pie.workspace.pie.delivery.domains.5eccddaa0f', 'Severity'),
          pill: true
        },
        {
          key: 'status',
          label: translate('auto.pie.workspace.pie.delivery.domains.5577678c87', 'Status'),
          pill: true
        }
      ],
      createPath: '/projects/{projectId}/defects',
      createFields: [
        {
          key: 'title',
          label: translate('auto.pie.workspace.pie.delivery.domains.e81fd696ec', 'Title'),
          required: true
        },
        {
          key: 'description',
          label: translate('auto.pie.workspace.pie.delivery.domains.f31f87fec9', 'Description'),
          type: 'textarea'
        },
        {
          key: 'severity',
          label: translate('auto.pie.workspace.pie.delivery.domains.5eccddaa0f', 'Severity'),
          type: 'select',
          options: ['low', 'medium', 'high', 'critical']
        }
      ],
      detailFields: [
        {
          key: 'title',
          label: translate('auto.pie.workspace.pie.delivery.domains.e81fd696ec', 'Title')
        },
        {
          key: 'description',
          label: translate('auto.pie.workspace.pie.delivery.domains.f31f87fec9', 'Description')
        },
        {
          key: 'severity',
          label: translate('auto.pie.workspace.pie.delivery.domains.5eccddaa0f', 'Severity')
        },
        {
          key: 'status',
          label: translate('auto.pie.workspace.pie.delivery.domains.5577678c87', 'Status')
        }
      ],
      actions: [
        {
          label: translate('auto.pie.workspace.pie.delivery.domains.2f763b3394', 'Triage'),
          verb: 'transition',
          body: { action: 'triage' },
          occ: true
        },
        {
          label: translate('auto.pie.workspace.pie.delivery.domains.da87343849', 'Resolve'),
          verb: 'transition',
          body: { action: 'resolve' },
          occ: true
        },
        {
          label: translate('auto.pie.workspace.pie.delivery.domains.31d542fb20', 'Close'),
          verb: 'transition',
          body: { action: 'close' },
          occ: true
        }
      ]
    },
    {
      key: 'risks',
      label: translate('auto.pie.workspace.pie.delivery.domains.f87ead2c8e', 'Project Risks'),
      scope: 'project',
      listPath: '/projects/{projectId}/risks',
      itemPath: (id) => `/risks/${id}`,
      etagPrefix: 'risk',
      columns: [
        {
          key: 'title',
          label: translate('auto.pie.workspace.pie.delivery.domains.e81fd696ec', 'Title')
        },
        {
          key: 'severity',
          label: translate('auto.pie.workspace.pie.delivery.domains.5eccddaa0f', 'Severity'),
          pill: true
        },
        {
          key: 'status',
          label: translate('auto.pie.workspace.pie.delivery.domains.5577678c87', 'Status'),
          pill: true
        }
      ],
      createPath: '/projects/{projectId}/risks',
      createFields: [
        {
          key: 'title',
          label: translate('auto.pie.workspace.pie.delivery.domains.e81fd696ec', 'Title'),
          required: true
        },
        {
          key: 'description',
          label: translate('auto.pie.workspace.pie.delivery.domains.f31f87fec9', 'Description'),
          type: 'textarea'
        },
        {
          key: 'category',
          label: translate('auto.pie.workspace.pie.delivery.domains.f2793498c9', 'Category'),
          type: 'select',
          options: ['schedule', 'budget', 'technical', 'resource', 'external']
        },
        {
          key: 'probability',
          label: translate('auto.pie.workspace.pie.delivery.domains.4d670ba007', 'Probability'),
          type: 'select',
          options: ['low', 'medium', 'high']
        },
        {
          key: 'impact',
          label: translate('auto.pie.workspace.pie.delivery.domains.f50a9db9fc', 'Impact'),
          type: 'select',
          options: ['low', 'medium', 'high']
        },
        {
          key: 'mitigation',
          label: translate('auto.pie.workspace.pie.delivery.domains.81b7126888', 'Mitigation'),
          type: 'textarea'
        }
      ],
      detailFields: [
        {
          key: 'title',
          label: translate('auto.pie.workspace.pie.delivery.domains.e81fd696ec', 'Title')
        },
        {
          key: 'severity',
          label: translate('auto.pie.workspace.pie.delivery.domains.5eccddaa0f', 'Severity')
        },
        {
          key: 'mitigation',
          label: translate('auto.pie.workspace.pie.delivery.domains.81b7126888', 'Mitigation')
        },
        {
          key: 'status',
          label: translate('auto.pie.workspace.pie.delivery.domains.5577678c87', 'Status')
        }
      ],
      actions: [
        {
          label: translate('auto.pie.workspace.pie.delivery.domains.83130cda83', 'Mitigate'),
          verb: 'transition',
          body: { action: 'mitigate' },
          occ: true
        },
        {
          label: translate('auto.pie.workspace.pie.delivery.domains.31d542fb20', 'Close'),
          verb: 'transition',
          body: { action: 'close' },
          occ: true
        },
        {
          label: translate('auto.pie.workspace.pie.delivery.domains.9622b7c6fa', 'Accept'),
          verb: 'transition',
          body: { action: 'accept' },
          occ: true
        }
      ]
    },
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
      createFields: [
        {
          key: 'periodStart',
          label: translate('auto.pie.workspace.pie.delivery.domains.03b015adff', 'Period start'),
          type: 'date'
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
          options: ['green', 'amber', 'red']
        },
        {
          key: 'summary',
          label: translate('auto.pie.workspace.pie.delivery.domains.856bc71328', 'Summary'),
          type: 'textarea',
          required: true
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
        }
      ]
    }
  ]
}
