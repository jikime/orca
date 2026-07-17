import type { PieSendMessageOptions } from '../../../../shared/pie-chat-contract'
import type { TimelineMessage } from './use-pie-chat'

// Builds the local echo shown immediately on send, before the server confirms.
// The real id/version arrive when sendMessage resolves and replaces this entry.
export function createOptimisticMessage(
  channelId: string,
  authorId: string,
  body: string,
  opts?: PieSendMessageOptions
): TimelineMessage {
  const optimisticId = globalThis.crypto.randomUUID()
  return {
    optimisticId,
    pending: true,
    id: optimisticId,
    organizationId: '',
    channelId,
    authorId,
    body,
    visibility: 'internal',
    version: 1,
    threadRootMessageId: opts?.threadRootMessageId ?? null,
    replyCount: 0,
    reactions: [],
    attachments: [],
    createdAt: new Date().toISOString(),
    edited: false,
    revisionCount: 0,
    deleted: false,
    deletedAt: null,
    deletedBy: null,
    deletionReason: null,
    pinned: false
  }
}
