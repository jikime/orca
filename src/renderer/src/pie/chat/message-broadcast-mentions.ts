const FENCED_CODE = /```[\s\S]*?```/gu
const INLINE_CODE = /`[^`\n]*`/gu

function outsideCode(body: string): string {
  return body.replace(FENCED_CODE, '').replace(INLINE_CODE, '')
}

function containsMention(body: string, scope: 'channel' | 'here'): boolean {
  const pattern = new RegExp(`(^|\\s)@${scope}(?=$|[\\s.,!?;:])`, 'iu')
  return pattern.test(outsideCode(body))
}

// Group mentions are explicit transport fields; sending text alone would render
// “@channel” without creating the durable notifications users expect.
export function broadcastMentionOptions(body: string): {
  mentionChannel: boolean
  mentionHere: boolean
} {
  return {
    mentionChannel: containsMention(body, 'channel'),
    mentionHere: containsMention(body, 'here')
  }
}
