// @vitest-environment happy-dom

import { act } from 'react'
import { fireEvent } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const control = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn()
}))

vi.mock('../control-plane/pie-api-client', () => ({
  apiGet: control.get,
  apiPatch: control.patch,
  resourceEtag: (prefix: string, version: number) => `"${prefix}-${version}"`,
  PieApiError: class PieApiError extends Error {}
}))

import { MeetingTranscriptTimeline } from './MeetingTranscriptTimeline'
import type { MeetingTranscript, MeetingTranscriptSegment } from './meeting-types'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const transcript: MeetingTranscript = {
  id: '40000000-0000-4000-8000-000000000001',
  organizationId: '10000000-0000-4000-8000-000000000001',
  meetingId: '20000000-0000-4000-8000-000000000001',
  content: 'Original text',
  segments: [],
  source: 'post_recording',
  language: 'en',
  version: 1,
  createdAt: '2026-07-21T00:00:00.000Z',
  updatedAt: '2026-07-21T00:00:00.000Z'
}

const segment: MeetingTranscriptSegment = {
  id: '50000000-0000-4000-8000-000000000001',
  organizationId: transcript.organizationId,
  meetingId: transcript.meetingId,
  transcriptId: transcript.id,
  sequence: 0,
  speakerParticipantId: null,
  speakerLabel: 'Speaker A',
  startMs: 2_500,
  endMs: 4_000,
  text: 'Original text',
  language: 'en',
  confidence: 0.9,
  source: 'post_recording',
  version: 1,
  createdAt: '2026-07-21T00:00:00.000Z',
  updatedAt: '2026-07-21T00:00:00.000Z'
}

let root: Root | null = null
let container: HTMLDivElement | null = null

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 250))
  })
}

beforeEach(() => {
  control.get.mockReset().mockResolvedValue({ items: [segment], nextCursor: null })
  control.patch.mockReset().mockResolvedValue({
    ...segment,
    speakerLabel: 'Alice',
    text: 'Corrected text',
    source: 'corrected',
    version: 2
  })
})

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  container?.remove()
  root = null
  container = null
})

describe('MeetingTranscriptTimeline', () => {
  it('loads timed segments, seeks playback, and preserves an OCC correction', async () => {
    const onSeek = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root?.render(<MeetingTranscriptTimeline transcript={transcript} canManage onSeek={onSeek} />)
    })
    await flush()

    expect(container.textContent).toContain('Original text')
    act(() => fireEvent.click(container?.querySelector('[aria-label="Play from 0:02"]') as Element))
    expect(onSeek).toHaveBeenCalledWith(2_500)

    act(() =>
      fireEvent.click(container?.querySelector('[aria-label="Correct segment"]') as Element)
    )
    act(() => {
      fireEvent.change(container?.querySelector('[aria-label="Speaker"]') as Element, {
        target: { value: 'Alice' }
      })
      fireEvent.change(container?.querySelector('[aria-label="Transcript text"]') as Element, {
        target: { value: 'Corrected text' }
      })
    })
    const save = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Save')
    )
    await act(async () => fireEvent.click(save as Element))

    expect(control.patch).toHaveBeenCalledWith(
      `/meeting-transcript-segments/${segment.id}`,
      { speakerLabel: 'Alice', text: 'Corrected text' },
      '"meeting-transcript-segment-1"'
    )
    expect(container.textContent).toContain('Corrected text')
  })
})
