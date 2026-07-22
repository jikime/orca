import type { PendingAttachment } from './AttachmentComposer'

const STORAGE_PREFIX = 'orca.pie.chat.composer-draft.v1'
const DRAFT_SENT_EVENT = 'pie-chat:composer-draft-sent'

export type ChatComposerDraft = {
  body: string
  mentionUserIds: string[]
  attachments: PendingAttachment[]
  updatedAt: string
}

export function chatComposerDraftKey(
  ownerId: string,
  channelId: string,
  threadRootMessageId?: string
): string {
  return `${STORAGE_PREFIX}:${ownerId}:${channelId}:${threadRootMessageId ?? 'root'}`
}

function isAttachment(value: unknown): value is PendingAttachment {
  if (!value || typeof value !== 'object') {
    return false
  }
  const attachment = value as Record<string, unknown>
  return typeof attachment.id === 'string' && typeof attachment.filename === 'string'
}

export function readChatComposerDraft(key: string): ChatComposerDraft | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) {
      return null
    }
    const value = JSON.parse(raw) as Record<string, unknown>
    if (
      typeof value.body !== 'string' ||
      !Array.isArray(value.mentionUserIds) ||
      !value.mentionUserIds.every((item) => typeof item === 'string') ||
      !Array.isArray(value.attachments) ||
      !value.attachments.every(isAttachment) ||
      typeof value.updatedAt !== 'string'
    ) {
      return null
    }
    return {
      body: value.body,
      mentionUserIds: value.mentionUserIds,
      // Blob preview URLs are process-local, so only durable attachment metadata is restored.
      attachments: value.attachments.map(({ id, filename, contentType }) => ({
        id,
        filename,
        ...(contentType ? { contentType } : {})
      })),
      updatedAt: value.updatedAt
    }
  } catch {
    // Hardened renderer contexts can deny storage; chat must remain usable without drafts.
    return null
  }
}

export function writeChatComposerDraft(key: string, draft: ChatComposerDraft): void {
  try {
    const hasContent = draft.body.trim().length > 0 || draft.attachments.length > 0
    if (!hasContent) {
      window.localStorage.removeItem(key)
      return
    }
    window.localStorage.setItem(
      key,
      JSON.stringify({
        ...draft,
        attachments: draft.attachments.map(({ id, filename, contentType }) => ({
          id,
          filename,
          ...(contentType ? { contentType } : {})
        }))
      })
    )
  } catch {
    // Storage quota or policy failures must not block message composition.
  }
}

export function clearChatComposerDraft(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // A successful send is authoritative even when local cleanup is unavailable.
  }
}

export function announceChatComposerDraftSent(key: string, clientRequestId: string): void {
  window.dispatchEvent(new CustomEvent(DRAFT_SENT_EVENT, { detail: { key, clientRequestId } }))
}

export function onChatComposerDraftSent(
  callback: (detail: { key: string; clientRequestId: string }) => void
): () => void {
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<unknown>).detail
    if (!detail || typeof detail !== 'object') {
      return
    }
    const candidate = detail as Record<string, unknown>
    if (typeof candidate.key === 'string' && typeof candidate.clientRequestId === 'string') {
      callback({ key: candidate.key, clientRequestId: candidate.clientRequestId })
    }
  }
  window.addEventListener(DRAFT_SENT_EVENT, listener)
  return () => window.removeEventListener(DRAFT_SENT_EVENT, listener)
}
