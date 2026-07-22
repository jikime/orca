import { useState } from 'react'
import { Check, History, Pencil, Play, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { apiGet } from '../control-plane/pie-api-client'
import type { MeetingTranscriptSegment, MeetingTranscriptSegmentRevision } from './meeting-types'

function timestamp(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1_000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

export function MeetingTranscriptSegmentRow({
  segment,
  canManage,
  onSeek,
  onCorrect
}: {
  segment: MeetingTranscriptSegment
  canManage: boolean
  onSeek: (milliseconds: number) => void
  onCorrect: (
    segment: MeetingTranscriptSegment,
    correction: { speakerLabel: string; text: string }
  ) => Promise<void>
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [speakerLabel, setSpeakerLabel] = useState(segment.speakerLabel)
  const [text, setText] = useState(segment.text)
  const [saving, setSaving] = useState(false)
  const [revisions, setRevisions] = useState<MeetingTranscriptSegmentRevision[] | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)

  const save = async (): Promise<void> => {
    if (!speakerLabel.trim() || !text.trim()) {
      return
    }
    setSaving(true)
    try {
      await onCorrect(segment, { speakerLabel: speakerLabel.trim(), text: text.trim() })
      setEditing(false)
      setRevisions(null)
    } finally {
      setSaving(false)
    }
  }

  const toggleHistory = async (): Promise<void> => {
    const open = !historyOpen
    setHistoryOpen(open)
    if (open && revisions === null) {
      const response = await apiGet<{ items: MeetingTranscriptSegmentRevision[] }>(
        `/meeting-transcript-segments/${segment.id}/revisions`
      )
      setRevisions(response.items)
    }
  }

  return (
    <article className="group rounded-md border border-border bg-card px-2.5 py-2">
      <div className="flex items-start gap-2">
        <Button
          size="xs"
          variant="ghost"
          className="mt-0.5 shrink-0 font-mono text-[11px] text-muted-foreground"
          onClick={() => onSeek(segment.startMs)}
          aria-label={translate(
            'auto.pie.meetings.MeetingTranscriptSegmentRow.seek',
            'Play from {{value0}}',
            { value0: timestamp(segment.startMs) }
          )}
        >
          <Play className="size-3" />
          {timestamp(segment.startMs)}
        </Button>
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="space-y-2">
              <Input
                value={speakerLabel}
                onChange={(event) => setSpeakerLabel(event.target.value)}
                aria-label={translate(
                  'auto.pie.meetings.MeetingTranscriptSegmentRow.speaker',
                  'Speaker'
                )}
              />
              <Textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                className="min-h-20 resize-y"
                aria-label={translate(
                  'auto.pie.meetings.MeetingTranscriptSegmentRow.text',
                  'Transcript text'
                )}
              />
              <div className="flex gap-1">
                <Button
                  size="xs"
                  onClick={() => void save()}
                  disabled={saving || !speakerLabel.trim() || !text.trim()}
                >
                  <Check />
                  {translate('auto.pie.meetings.MeetingTranscriptSegmentRow.save', 'Save')}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setSpeakerLabel(segment.speakerLabel)
                    setText(segment.text)
                    setEditing(false)
                  }}
                >
                  <X />
                  {translate('auto.pie.meetings.MeetingTranscriptSegmentRow.cancel', 'Cancel')}
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-1.5">
                <strong className="truncate text-xs font-semibold text-foreground">
                  {segment.speakerLabel}
                </strong>
                {segment.source === 'corrected' && (
                  <span className="text-[10px] text-muted-foreground">
                    {translate(
                      'auto.pie.meetings.MeetingTranscriptSegmentRow.corrected',
                      'corrected'
                    )}
                  </span>
                )}
                <div className="ml-auto flex opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                  {segment.version > 1 && (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      onClick={() => void toggleHistory()}
                      aria-label={translate(
                        'auto.pie.meetings.MeetingTranscriptSegmentRow.history',
                        'Revision history'
                      )}
                    >
                      <History />
                    </Button>
                  )}
                  {canManage && (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      onClick={() => setEditing(true)}
                      aria-label={translate(
                        'auto.pie.meetings.MeetingTranscriptSegmentRow.edit',
                        'Correct segment'
                      )}
                    >
                      <Pencil />
                    </Button>
                  )}
                </div>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-foreground">
                {segment.text}
              </p>
            </>
          )}
        </div>
      </div>
      {historyOpen && (
        <div className="mt-2 space-y-1 border-t border-border pt-2 pl-16">
          {revisions === null ? (
            <p className="text-[11px] text-muted-foreground">
              {translate('auto.pie.meetings.MeetingTranscriptSegmentRow.loading', 'Loading…')}
            </p>
          ) : revisions.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              {translate(
                'auto.pie.meetings.MeetingTranscriptSegmentRow.noHistory',
                'No earlier revision'
              )}
            </p>
          ) : (
            revisions.map((revision) => (
              <div key={revision.id} className="rounded bg-muted/40 px-2 py-1.5 text-[11px]">
                <span className="font-medium text-foreground">
                  v{revision.revision} · {revision.speakerLabel}
                </span>
                <p className="mt-0.5 text-muted-foreground">{revision.text}</p>
              </div>
            ))
          )}
        </div>
      )}
    </article>
  )
}
