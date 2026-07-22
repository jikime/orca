export type MeetingTranscription = {
  text: string
  segments: Array<Record<string, unknown>>
  language: string | null
}

export type MeetingMinutesDraft = {
  summary: string
  decisions: Array<{ statement: string; evidenceQuote: string | null }>
  actionItems: Array<{
    task: string
    owner: string | null
    due: string | null
    evidenceQuote: string | null
  }>
}

export type MeetingAiClient = {
  transcribe: (audio: Uint8Array, filename: string) => Promise<MeetingTranscription>
  draftMinutes: (transcript: string) => Promise<MeetingMinutesDraft>
}

type FetchLike = typeof fetch

function responseText(body: Record<string, unknown>): string | null {
  if (typeof body.output_text === 'string') return body.output_text
  const output = Array.isArray(body.output) ? body.output : []
  for (const item of output) {
    const content = (item as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      const text = (part as { text?: unknown }).text
      if (typeof text === 'string') return text
    }
  }
  return null
}

async function checkedJson(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json()) as Record<string, unknown>
  if (!response.ok) {
    const detail = JSON.stringify(body).slice(0, 1_000)
    throw new Error(`OpenAI request failed (${response.status}): ${detail}`)
  }
  return body
}

export function createMeetingAiClient(input: {
  apiKey: string
  baseUrl: string
  transcriptionModel: string
  minutesModel: string
  fetchImpl?: FetchLike
}): MeetingAiClient {
  const fetchImpl = input.fetchImpl ?? fetch
  const headers = { authorization: `Bearer ${input.apiKey}` }
  return {
    transcribe: async (audio, filename) => {
      if (audio.byteLength > 25 * 1024 * 1024) {
        throw new Error('meeting transcription audio exceeds the 25 MB model upload limit')
      }
      const form = new FormData()
      form.append('file', new Blob([audio], { type: 'audio/mpeg' }), filename)
      form.append('model', input.transcriptionModel)
      form.append('response_format', 'diarized_json')
      // Diarization requires server-side chunking for recordings longer than 30 seconds.
      form.append('chunking_strategy', 'auto')
      const body = await checkedJson(
        await fetchImpl(`${input.baseUrl}/v1/audio/transcriptions`, {
          method: 'POST',
          headers,
          body: form
        })
      )
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (!text) throw new Error('OpenAI transcription returned no text')
      return {
        text,
        segments: Array.isArray(body.segments)
          ? (body.segments as Array<Record<string, unknown>>)
          : [],
        language: typeof body.language === 'string' ? body.language : null
      }
    },
    draftMinutes: async (transcript) => {
      const body = await checkedJson(
        await fetchImpl(`${input.baseUrl}/v1/responses`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: input.minutesModel,
            input: [
              {
                role: 'system',
                content:
                  'Create factual meeting minutes from only the transcript. Preserve the transcript language. Never invent decisions, owners, or due dates; use null when absent. For each decision and action item, include a short exact evidenceQuote copied from the transcript or null when no exact quote supports it.'
              },
              { role: 'user', content: transcript }
            ],
            text: {
              format: {
                type: 'json_schema',
                name: 'meeting_minutes',
                strict: true,
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['summary', 'decisions', 'actionItems'],
                  properties: {
                    summary: { type: 'string' },
                    decisions: {
                      type: 'array',
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['statement', 'evidenceQuote'],
                        properties: {
                          statement: { type: 'string' },
                          evidenceQuote: { type: ['string', 'null'] }
                        }
                      }
                    },
                    actionItems: {
                      type: 'array',
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['task', 'owner', 'due', 'evidenceQuote'],
                        properties: {
                          task: { type: 'string' },
                          owner: { type: ['string', 'null'] },
                          due: { type: ['string', 'null'] },
                          evidenceQuote: { type: ['string', 'null'] }
                        }
                      }
                    }
                  }
                }
              }
            }
          })
        })
      )
      const output = responseText(body)
      if (!output) throw new Error('OpenAI minutes response returned no structured output')
      return JSON.parse(output) as MeetingMinutesDraft
    }
  }
}

export function renderMeetingMinutes(draft: MeetingMinutesDraft): string {
  const decisions =
    draft.decisions.length > 0
      ? draft.decisions.map((decision) => `- ${decision.statement}`).join('\n')
      : '- 기록된 결정 사항 없음'
  const actions =
    draft.actionItems.length > 0
      ? draft.actionItems
          .map((item) => {
            const details = [
              item.owner ? `담당: ${item.owner}` : null,
              item.due ? `기한: ${item.due}` : null
            ].filter(Boolean)
            return `- [ ] ${item.task}${details.length > 0 ? ` — ${details.join(' · ')}` : ''}`
          })
          .join('\n')
      : '- 기록된 후속 조치 없음'
  return `# 회의 요약\n\n${draft.summary.trim()}\n\n## 결정 사항\n\n${decisions}\n\n## 후속 조치\n\n${actions}`
}
