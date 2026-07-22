import type { PieDomainConfig } from './pie-domain-types'
import { translate } from '@/i18n/i18n'

// Work Portal — quality surfaces: defects and risks raised against a project.
export function buildPiePortalQualityDomains(): readonly PieDomainConfig[] {
  return [
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
      editable: true,
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
      etagPrefix: 'project-risk',
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
      editable: true,
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
    }
  ]
}
