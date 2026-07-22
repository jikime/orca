import { useTranslation } from 'react-i18next'
import { ChatScreen } from '../chat/ChatScreen'
import { MeetingWorkspace } from '../meetings/MeetingWorkspace'
import { PieResourceScreen } from './PieResourceScreen'
import { ProjectWorkspace } from './ProjectWorkspace'
import { WorkItemBoard } from './WorkItemBoard'
import {
  buildPieAdminDomains,
  buildPieCommunicationDomains,
  buildPieCustomerDomains,
  buildPieSupportDomains
} from './pie-domain-registry'
import { usePieWorkspaceRoute } from './pie-workspace-route'

// Pie navigation lives in the app sidebar; this component owns only the selected content.
export function PieWorkspace(): React.JSX.Element {
  useTranslation()
  const active = usePieWorkspaceRoute()
  const domain = [
    ...buildPieCommunicationDomains(),
    ...buildPieCustomerDomains(),
    ...buildPieSupportDomains(),
    ...buildPieAdminDomains()
  ].find((candidate) => candidate.key === active)

  return (
    <div className="h-full min-h-0 min-w-0 bg-background">
      {active === 'meetings' ? (
        <MeetingWorkspace />
      ) : active === 'projects' ? (
        <ProjectWorkspace />
      ) : active === 'my-work' ? (
        <WorkItemBoard scope="mine" />
      ) : active === 'work-item' ? (
        <WorkItemBoard />
      ) : domain ? (
        <PieResourceScreen key={domain.key} config={domain} />
      ) : (
        <ChatScreen />
      )}
    </div>
  )
}
