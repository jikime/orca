import type { PieDomainConfig } from './pie-domain-types'
import { translate } from '@/i18n/i18n'

// Planning surfaces: the project itself plus its change requests and deliverables.
export function buildPieDeliveryPlanningDomains(): readonly PieDomainConfig[] {
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
    }
  ]
}
