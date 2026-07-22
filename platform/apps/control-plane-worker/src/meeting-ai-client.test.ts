import { describe, expect, it, vi } from 'vitest'
import { createMeetingAiClient, renderMeetingMinutes } from './meeting-ai-client'

describe('meeting AI client', () => {
  it('requests diarized transcription and strict structured minutes', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            text: 'Decision made.',
            language: 'en',
            segments: [{ speaker: 'A', start: 0, end: 1, text: 'Decision made.' }]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              summary: 'A decision was made.',
              decisions: [{ statement: 'Proceed.', evidenceQuote: 'Decision made.' }],
              actionItems: [
                { task: 'Ship', owner: null, due: null, evidenceQuote: 'Decision made.' }
              ]
            })
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    const client = createMeetingAiClient({
      apiKey: 'test-key',
      baseUrl: 'https://api.openai.test',
      transcriptionModel: 'gpt-4o-transcribe-diarize',
      minutesModel: 'gpt-5.6-luna',
      fetchImpl
    })
    const transcript = await client.transcribe(new Uint8Array([1]), 'meeting.mp3')
    const draft = await client.draftMinutes(transcript.text)
    expect(transcript.segments[0]).toMatchObject({ speaker: 'A' })
    const transcriptionForm = fetchImpl.mock.calls[0]?.[1]?.body as FormData
    expect(transcriptionForm.get('response_format')).toBe('diarized_json')
    expect(transcriptionForm.get('chunking_strategy')).toBe('auto')
    const minutesRequest = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)) as {
      text: { format: { strict: boolean } }
    }
    expect(minutesRequest.text.format.strict).toBe(true)
    expect(renderMeetingMinutes(draft)).toContain('- [ ] Ship')
  })
})
