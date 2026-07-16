import { describe, expect, it } from 'vitest'
import {
  buildOrganizationUpdatedCloudEvent,
  buildResourceChangedMessage,
  decodeCursor,
  encodeCursor,
  parseResourceChangeCloudEvent
} from './resource-change-event'

describe('resource-change cursor', () => {
  it('round-trips a sequence through the opaque cursor', () => {
    expect(decodeCursor(encodeCursor(43))).toBe(43)
    expect(encodeCursor(43)).toBe('cursor-00000043')
  })

  it('rejects a cursor this server did not issue', () => {
    expect(decodeCursor('not-a-cursor')).toBeNull()
    expect(decodeCursor('cursor-xyz')).toBeNull()
  })
})

describe('resource-change envelope', () => {
  it('parses a well-formed CloudEvent and builds the realtime message', () => {
    const envelope = buildOrganizationUpdatedCloudEvent({
      organizationId: '11111111-1111-4111-8111-111111111111',
      eventId: '22222222-2222-4222-8222-222222222222',
      version: 5,
      occurredAt: '2026-07-18T00:00:00.000Z'
    })
    const change = parseResourceChangeCloudEvent(envelope)
    expect(change).not.toBeNull()
    const message = buildResourceChangedMessage(envelope.pieorgid, change!, encodeCursor(9))
    expect(message).toMatchObject({
      type: 'resource.changed',
      schemaVersion: 1,
      cursor: 'cursor-00000009',
      resourceType: 'organization',
      changeKind: 'updated',
      version: 5
    })
  })

  it('treats a non-envelope payload as poison (null)', () => {
    expect(parseResourceChangeCloudEvent({ nope: true })).toBeNull()
    expect(parseResourceChangeCloudEvent(null)).toBeNull()
  })
})
