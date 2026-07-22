import type { PieDomainConfig } from './pie-domain-types'
import { PieResourceMeetingLinks } from './PieResourceMeetingLinks'

export function PieResourceMeetingContext({
  config,
  resource
}: {
  config: PieDomainConfig
  resource: Record<string, unknown> & { id: string }
}): React.JSX.Element | null {
  const scope = config.contextMeetingScope
  return scope ? (
    <PieResourceMeetingLinks
      scopeKind={scope.kind}
      resourceId={resource.id}
      title={String(resource[scope.titleKey] ?? config.label)}
    />
  ) : null
}
