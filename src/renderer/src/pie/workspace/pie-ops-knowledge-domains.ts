import type { PieDomainConfig } from './pie-domain-types'
import { translate } from '@/i18n/i18n'

// Knowledge & operations surfaces: articles, runbooks, and tracked assets.
export function buildPieOpsKnowledgeDomains(): readonly PieDomainConfig[] {
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
    }
  ]
}
