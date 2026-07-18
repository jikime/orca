import type { PieDomainConfig } from './pie-domain-types'
import { translate } from '@/i18n/i18n'

// Admin module: AI entitlements and governance.
export function buildPieAdminDomains(): readonly PieDomainConfig[] {
  return [
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
