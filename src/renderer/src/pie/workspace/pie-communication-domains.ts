import type { PieDomainConfig } from './pie-domain-types'
import { translate } from '@/i18n/i18n'

// Communication module: meeting records (chat itself has its own full-screen surface).
export function buildPieCommunicationDomains(): readonly PieDomainConfig[] {
  return [
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
          options: ['none', 'project', 'ticket', 'remote_session']
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
    }
  ]
}
