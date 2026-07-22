import { ListChecks, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getLocalPreflightContext, localPreflightContextKey } from '@/lib/local-preflight-context'
import { cn } from '@/lib/utils'
import { WorkItemBoard } from '@/pie/workspace/WorkItemBoard'
import { useAppStore } from '@/store'
import { isGitRepoKind } from '../../../shared/repo-kind'
import {
  normalizeVisibleTaskProviders,
  restoreAvailableDefaultTaskProvider
} from '../../../shared/task-providers'
import { translate } from '@/i18n/i18n'
import { getSourceOptions } from './task-page-localized-options'

export default function PieTaskPage(): React.JSX.Element {
  useTranslation()
  const settings = useAppStore((state) => state.settings)
  const repos = useAppStore((state) => state.repos)
  const preflightStatus = useAppStore((state) => state.preflightStatus)
  const preflightStatusContextKey = useAppStore((state) => state.preflightStatusContextKey)
  const expectedPreflightContextKey = useAppStore((state) =>
    localPreflightContextKey(getLocalPreflightContext(state))
  )
  const linearConnected = useAppStore((state) => state.linearStatus.connected === true)
  const openTaskPage = useAppStore((state) => state.openTaskPage)
  const closeTaskPage = useAppStore((state) => state.closeTaskPage)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const hasGitRepo = repos.some((repo) => isGitRepoKind(repo))
  const visibleProviders = restoreAvailableDefaultTaskProvider(
    normalizeVisibleTaskProviders(settings?.visibleTaskProviders),
    {
      gitlabInstalled:
        preflightStatusContextKey === expectedPreflightContextKey &&
        preflightStatus?.glab?.installed === true,
      linearConnected
    },
    settings?.defaultTaskSource
  )
  const providerOptions = getSourceOptions().filter((source) =>
    visibleProviders.includes(source.id)
  )

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background px-5 pt-1.5 pb-4 text-foreground md:px-8 md:pb-5">
      <div
        className="flex flex-none items-center gap-2"
        data-contextual-tour-target="tasks-source-filters"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 rounded-full"
              onClick={closeTaskPage}
              aria-label={translate('auto.components.TaskPage.1a06219d5c', 'Close tasks')}
            >
              <X className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate('auto.components.TaskPage.4826fd1ad8', 'Close · Esc')}
          </TooltipContent>
        </Tooltip>
        <div className="mx-1 h-5 w-px bg-border/50" aria-hidden />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-task-source="pie"
              aria-label={translate('auto.components.PieTaskPage.source', 'Pie · My Work')}
              aria-pressed
              className="flex h-8 w-8 items-center justify-center rounded-md border border-foreground/40 bg-muted/70 text-foreground shadow-sm"
            >
              <ListChecks className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate('auto.components.PieTaskPage.source', 'Pie · My Work')}
          </TooltipContent>
        </Tooltip>
        {providerOptions.map((source) => {
          const disabled =
            source.disabled || ((source.id === 'github' || source.id === 'gitlab') && !hasGitRepo)
          return (
            <Tooltip key={source.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  disabled={disabled}
                  data-task-source={source.id}
                  aria-label={source.label}
                  aria-pressed={false}
                  onClick={() => {
                    openTaskPage({ taskSource: source.id }, { recordTasksInteraction: false })
                    void updateSettings({ defaultTaskSource: source.id }).catch(() => {
                      toast.error(
                        translate(
                          'auto.components.TaskPage.609532fae7',
                          'Failed to save default task source.'
                        )
                      )
                    })
                  }}
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-md border border-border/40 bg-transparent text-muted-foreground transition hover:bg-muted/40 hover:text-foreground',
                    disabled && 'cursor-not-allowed opacity-55'
                  )}
                >
                  <source.Icon className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {source.label}
              </TooltipContent>
            </Tooltip>
          )
        })}
        <div className="hidden min-w-0 max-w-[min(420px,40vw)] items-center rounded-md border border-border/50 bg-muted/35 px-2 py-1 text-xs text-muted-foreground sm:flex">
          <span className="truncate">
            {translate('auto.components.PieTaskPage.context', 'Pie · Assigned to me')}
          </span>
        </div>
      </div>
      <div className="mt-2 min-h-0 min-w-0 flex-1 overflow-hidden rounded-md border border-border/50 bg-background shadow-sm">
        <WorkItemBoard scope="mine" />
      </div>
    </div>
  )
}
