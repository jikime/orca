import { Monitor, PanelsTopLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import type { MeetingDisplaySource } from '../../../../shared/meeting-display-source'

export function MeetingDisplaySourceDialog({
  open,
  sources,
  onOpenChange,
  onSelect
}: {
  open: boolean
  sources: MeetingDisplaySource[]
  onOpenChange: (open: boolean) => void
  onSelect: (source: MeetingDisplaySource) => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.pie.meetings.MeetingDisplaySourceDialog.title',
              'Share a screen or window'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.pie.meetings.MeetingDisplaySourceDialog.description',
              'Only the source you choose will be visible to meeting participants.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[55vh] grid-cols-2 gap-3 overflow-y-auto pr-1 scrollbar-sleek md:grid-cols-3">
          {sources.map((source) => (
            <button
              key={source.id}
              type="button"
              className="overflow-hidden rounded-lg border border-border bg-card text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              onClick={() => onSelect(source)}
            >
              <div className="aspect-video bg-muted">
                {source.thumbnailDataUrl ? (
                  <img src={source.thumbnailDataUrl} alt="" className="size-full object-contain" />
                ) : (
                  <div className="flex size-full items-center justify-center text-muted-foreground">
                    {source.kind === 'screen' ? <Monitor /> : <PanelsTopLeft />}
                  </div>
                )}
              </div>
              <span className="block truncate border-t border-border px-2 py-1.5 text-xs text-foreground">
                {source.name}
              </span>
            </button>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {translate('auto.pie.meetings.MeetingDisplaySourceDialog.cancel', 'Cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
