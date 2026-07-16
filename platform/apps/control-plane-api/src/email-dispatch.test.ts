import { describe, expect, it } from 'vitest'
import { createLoggingEmailSender, type PieEmailMessage } from './email-dispatch'

function captureLogger() {
  const entries: Record<string, unknown>[] = []
  return { entries, info: (fields: Record<string, unknown>) => entries.push(fields) }
}

const INVITE: PieEmailMessage = {
  kind: 'organization-invite',
  to: 'owner@example.com',
  organizationId: '11111111-1111-1111-1111-111111111111',
  data: { inviteId: 'abc' }
}

describe('email dispatch seam', () => {
  it('logs structurally and sends nothing (dev no-op)', async () => {
    const logger = captureLogger()
    const sender = createLoggingEmailSender(logger)

    const result = await sender.send(INVITE)

    expect(result).toEqual({ dispatched: false, reason: 'dev-noop-sender' })
    expect(logger.entries).toHaveLength(1)
    const entry = logger.entries[0]!
    expect(entry.event).toBe('email.noop')
    expect(entry.kind).toBe('organization-invite')
    expect(entry.organizationId).toBe(INVITE.organizationId)
  })

  it('masks the recipient address in the log line', async () => {
    const logger = captureLogger()
    await createLoggingEmailSender(logger).send(INVITE)
    const to = logger.entries[0]!.to as string
    expect(to).toBe('o***@example.com')
    expect(to).not.toContain('owner')
  })
})
