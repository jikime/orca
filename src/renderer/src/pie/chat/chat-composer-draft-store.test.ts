// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest'
import {
  chatComposerDraftKey,
  clearChatComposerDraft,
  readChatComposerDraft,
  writeChatComposerDraft
} from './chat-composer-draft-store'

describe('chat composer draft store', () => {
  beforeEach(() => window.localStorage.clear())

  it('isolates root and thread drafts by owner and conversation', () => {
    expect(chatComposerDraftKey('u1', 'c1')).not.toBe(chatComposerDraftKey('u2', 'c1'))
    expect(chatComposerDraftKey('u1', 'c1')).not.toBe(chatComposerDraftKey('u1', 'c1', 'm1'))
  })

  it('round-trips body, mentions, and durable attachment metadata', () => {
    const key = chatComposerDraftKey('u1', 'c1')
    writeChatComposerDraft(key, {
      body: '**draft**',
      mentionUserIds: ['u2'],
      attachments: [
        {
          id: 'a1',
          filename: 'diagram.png',
          contentType: 'image/png',
          previewUrl: 'blob:temporary'
        }
      ],
      updatedAt: '2026-07-21T00:00:00.000Z'
    })

    expect(readChatComposerDraft(key)).toEqual({
      body: '**draft**',
      mentionUserIds: ['u2'],
      attachments: [{ id: 'a1', filename: 'diagram.png', contentType: 'image/png' }],
      updatedAt: '2026-07-21T00:00:00.000Z'
    })
  })

  it('removes empty and explicitly cleared drafts', () => {
    const key = chatComposerDraftKey('u1', 'c1')
    writeChatComposerDraft(key, {
      body: '',
      mentionUserIds: [],
      attachments: [],
      updatedAt: '2026-07-21T00:00:00.000Z'
    })
    expect(readChatComposerDraft(key)).toBeNull()

    window.localStorage.setItem(key, '{"body":"draft"}')
    clearChatComposerDraft(key)
    expect(window.localStorage.getItem(key)).toBeNull()
  })
})
