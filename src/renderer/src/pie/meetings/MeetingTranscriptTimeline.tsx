import { useCallback, useEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { FileText, LoaderCircle, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { apiGet, apiPatch, PieApiError, resourceEtag } from '../control-plane/pie-api-client'
import { MeetingTranscriptSegmentRow } from './MeetingTranscriptSegmentRow'
import type { MeetingTranscript, MeetingTranscriptSegment } from './meeting-types'

const VIRTUALIZATION_THRESHOLD = 100

function errorText(caught: unknown): string {
  if (caught instanceof PieApiError) {
    return `${caught.code ?? caught.status}: ${caught.message}`
  }
  return caught instanceof Error ? caught.message : String(caught)
}

export function MeetingTranscriptTimeline({
  transcript,
  canManage,
  onSeek
}: {
  transcript: MeetingTranscript
  canManage: boolean
  onSeek: (milliseconds: number) => void
}): React.JSX.Element {
  const [items, setItems] = useState<MeetingTranscriptSegment[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const requestSequence = useRef(0)

  const load = useCallback(
    async (cursor: string | null, replace: boolean): Promise<void> => {
      const sequence = ++requestSequence.current
      if (replace) {
        setLoading(true)
      } else {
        setLoadingMore(true)
      }
      setError(null)
      try {
        const search = new URLSearchParams({ limit: '100' })
        if (cursor) {
          search.set('cursor', cursor)
        }
        if (query.trim()) {
          search.set('query', query.trim())
        }
        const page = await apiGet<{
          items: MeetingTranscriptSegment[]
          nextCursor: string | null
        }>(`/meeting-transcripts/${transcript.id}/segments?${search}`)
        if (sequence !== requestSequence.current) {
          return
        }
        setItems((current) => (replace ? page.items : [...current, ...page.items]))
        setNextCursor(page.nextCursor)
      } catch (caught) {
        if (sequence === requestSequence.current) {
          setError(errorText(caught))
        }
      } finally {
        if (sequence === requestSequence.current) {
          setLoading(false)
          setLoadingMore(false)
        }
      }
    },
    [query, transcript.id]
  )

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(null, true), 200)
    return () => window.clearTimeout(timeout)
  }, [load])

  const correct = async (
    segment: MeetingTranscriptSegment,
    correction: { speakerLabel: string; text: string }
  ): Promise<void> => {
    setError(null)
    try {
      const updated = await apiPatch<MeetingTranscriptSegment>(
        `/meeting-transcript-segments/${segment.id}`,
        correction,
        resourceEtag('meeting-transcript-segment', segment.version)
      )
      setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)))
    } catch (caught) {
      setError(errorText(caught))
      throw caught
    }
  }

  const virtualized = items.length >= VIRTUALIZATION_THRESHOLD
  const virtualizer = useVirtualizer({
    count: virtualized ? items.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 92,
    overscan: 6
  })

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <FileText className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold text-foreground">
          {translate('auto.pie.meetings.MeetingTranscriptTimeline.title', 'Transcript timeline')}
        </h3>
        {transcript.language && (
          <span className="ml-auto text-[11px] text-muted-foreground">{transcript.language}</span>
        )}
      </div>
      <div className="space-y-2 p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="pl-8"
            placeholder={translate(
              'auto.pie.meetings.MeetingTranscriptTimeline.search',
              'Search transcript'
            )}
          />
        </div>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            {translate(
              'auto.pie.meetings.MeetingTranscriptTimeline.loading',
              'Loading transcript…'
            )}
          </div>
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            {translate(
              'auto.pie.meetings.MeetingTranscriptTimeline.empty',
              'No timed transcript segments'
            )}
          </p>
        ) : (
          <div ref={scrollRef} className="max-h-96 overflow-y-auto scrollbar-sleek">
            {virtualized ? (
              <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                {virtualizer.getVirtualItems().map((virtualRow) => {
                  const segment = items[virtualRow.index]!
                  return (
                    <div
                      key={segment.id}
                      ref={virtualizer.measureElement}
                      data-index={virtualRow.index}
                      className="absolute top-0 left-0 w-full pb-1.5"
                      style={{ transform: `translateY(${virtualRow.start}px)` }}
                    >
                      <MeetingTranscriptSegmentRow
                        segment={segment}
                        canManage={canManage}
                        onSeek={onSeek}
                        onCorrect={correct}
                      />
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="space-y-1.5">
                {items.map((segment) => (
                  <MeetingTranscriptSegmentRow
                    key={segment.id}
                    segment={segment}
                    canManage={canManage}
                    onSeek={onSeek}
                    onCorrect={correct}
                  />
                ))}
              </div>
            )}
          </div>
        )}
        {nextCursor && (
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            disabled={loadingMore}
            onClick={() => void load(nextCursor, false)}
          >
            {loadingMore && <LoaderCircle className="animate-spin" />}
            {translate('auto.pie.meetings.MeetingTranscriptTimeline.more', 'Load more')}
          </Button>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </section>
  )
}
