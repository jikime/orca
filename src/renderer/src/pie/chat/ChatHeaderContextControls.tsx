import { forwardRef, useMemo, useState, type ComponentProps, type ReactNode } from 'react'
import { Bell, Users, type LucideIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger
} from '@/components/ui/sheet'
import { translate } from '@/i18n/i18n'
import type {
  PieChannel,
  PieChannelMember,
  PieChatMember,
  PieChatRendererApi,
  PieNotification
} from '../../../../shared/pie-chat-contract'
import { MemberRoster } from './MemberRoster'
import { NotificationInbox } from './NotificationInbox'

type HeaderPanelProps = {
  triggerLabel: string
  title: string
  description: string
  Icon: LucideIcon
  badgeCount?: number
  onOpenChange?: (open: boolean) => void
  renderContent: (close: () => void) => ReactNode
}

type HeaderPanelButtonProps = Pick<
  HeaderPanelProps,
  'triggerLabel' | 'title' | 'Icon' | 'badgeCount'
> &
  Omit<ComponentProps<typeof Button>, 'children' | 'title'>

const HeaderPanelButton = forwardRef<HTMLButtonElement, HeaderPanelButtonProps>(
  function HeaderPanelButton(
    { triggerLabel, title, Icon, badgeCount = 0, ...triggerProps },
    ref
  ): React.JSX.Element {
    return (
      <Button
        {...triggerProps}
        ref={ref}
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={triggerLabel}
        title={title}
        className="relative"
      >
        <Icon />
        {badgeCount > 0 && (
          <Badge className="pointer-events-none absolute -top-1 -right-1 h-4 min-w-4 px-1 py-0 tabular-nums">
            {badgeCount > 99 ? '99+' : badgeCount}
          </Badge>
        )}
      </Button>
    )
  }
)

function ResponsiveHeaderPanel({
  triggerLabel,
  title,
  description,
  Icon,
  badgeCount,
  onOpenChange,
  renderContent
}: HeaderPanelProps): React.JSX.Element {
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const changePopover = (open: boolean): void => {
    setPopoverOpen(open)
    onOpenChange?.(open)
  }
  const changeSheet = (open: boolean): void => {
    setSheetOpen(open)
    onOpenChange?.(open)
  }

  return (
    <>
      <div data-chat-header-panel="popover" className="pie-chat-header-popover-control">
        <Popover open={popoverOpen} onOpenChange={changePopover}>
          <PopoverTrigger asChild>
            <HeaderPanelButton
              triggerLabel={triggerLabel}
              title={title}
              Icon={Icon}
              badgeCount={badgeCount}
            />
          </PopoverTrigger>
          <PopoverContent
            align="end"
            aria-label={title}
            className="pie-chat-header-floating-panel flex h-96 w-80 flex-col p-0"
          >
            {renderContent(() => changePopover(false))}
          </PopoverContent>
        </Popover>
      </div>
      <div data-chat-header-panel="sheet" className="pie-chat-header-sheet-control">
        <Sheet open={sheetOpen} onOpenChange={changeSheet}>
          <SheetTrigger asChild>
            <HeaderPanelButton
              triggerLabel={triggerLabel}
              title={title}
              Icon={Icon}
              badgeCount={badgeCount}
            />
          </SheetTrigger>
          <SheetContent
            className="pie-chat-header-floating-panel w-full max-w-full sm:max-w-sm"
            overlayClassName="pie-chat-header-sheet-overlay"
          >
            <SheetHeader className="border-b border-border">
              <SheetTitle>{title}</SheetTitle>
              <SheetDescription>{description}</SheetDescription>
            </SheetHeader>
            <div className="flex min-h-0 flex-1 flex-col">
              {renderContent(() => changeSheet(false))}
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </>
  )
}

type ChatHeaderContextControlsProps = {
  channel: PieChannel
  channels: PieChannel[]
  members: PieChatMember[]
  onlineUserIds: ReadonlySet<string>
  notifications: PieNotification[]
  unreadNotificationCount: number
  api: PieChatRendererApi
  onSelectNotification: (notification: PieNotification) => void
  onMarkAllNotificationsRead: () => void
}

export function ChatHeaderContextControls({
  channel,
  channels,
  members,
  onlineUserIds,
  notifications,
  unreadNotificationCount,
  api,
  onSelectNotification,
  onMarkAllNotificationsRead
}: ChatHeaderContextControlsProps): React.JSX.Element {
  const [channelMembers, setChannelMembers] = useState<PieChannelMember[]>([])
  const [loadingMembers, setLoadingMembers] = useState(false)
  const [memberError, setMemberError] = useState<string | null>(null)
  const roster = useMemo(
    () =>
      channelMembers.map((channelMember) => ({
        userId: channelMember.userId,
        displayName:
          members.find((member) => member.userId === channelMember.userId)?.displayName ??
          channelMember.userId.slice(0, 8)
      })),
    [channelMembers, members]
  )

  const loadMembers = async (): Promise<void> => {
    setLoadingMembers(true)
    setMemberError(null)
    try {
      setChannelMembers(await api.listChannelMembers(channel.id))
    } catch {
      setMemberError(
        translate(
          'auto.pie.chat.ChatHeaderContextControls.membersfailed',
          'Could not load channel members.'
        )
      )
    } finally {
      setLoadingMembers(false)
    }
  }

  return (
    <>
      <ResponsiveHeaderPanel
        triggerLabel={translate(
          'auto.pie.chat.ChatHeaderContextControls.openmembers',
          'Open channel members'
        )}
        title={translate('auto.pie.chat.ChatHeaderContextControls.members', 'Channel members')}
        description={translate(
          'auto.pie.chat.ChatHeaderContextControls.membersdescription',
          'See who belongs to this conversation and who is online.'
        )}
        Icon={Users}
        onOpenChange={(open) => {
          if (open) {
            void loadMembers()
          }
        }}
        renderContent={() =>
          loadingMembers ? (
            <p className="p-4 text-sm text-muted-foreground">
              {translate('auto.pie.chat.ChatHeaderContextControls.loading', 'Loading…')}
            </p>
          ) : memberError ? (
            <p className="p-4 text-sm text-destructive">{memberError}</p>
          ) : (
            <MemberRoster members={roster} onlineUserIds={onlineUserIds} />
          )
        }
      />
      <ResponsiveHeaderPanel
        triggerLabel={translate(
          'auto.pie.chat.ChatHeaderContextControls.opennotifications',
          'Open notifications'
        )}
        title={translate('auto.pie.chat.ChatHeaderContextControls.notifications', 'Notifications')}
        description={translate(
          'auto.pie.chat.ChatHeaderContextControls.notificationsdescription',
          'Review mentions and jump back to the original message.'
        )}
        Icon={Bell}
        badgeCount={unreadNotificationCount}
        renderContent={(close) => (
          <NotificationInbox
            notifications={notifications}
            channels={channels}
            unreadCount={unreadNotificationCount}
            surface="panel"
            onSelect={(notification) => {
              close()
              onSelectNotification(notification)
            }}
            onMarkAllRead={onMarkAllNotificationsRead}
          />
        )}
      />
    </>
  )
}
