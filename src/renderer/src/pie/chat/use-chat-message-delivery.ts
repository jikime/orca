import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'
import type {
  PieChatRendererApi,
  PieSendMessageOptions
} from '../../../../shared/pie-chat-contract'
import { createOptimisticMessage } from './optimistic-message'
import type { TimelineMessage } from './pie-chat-controller'
import { announceChatComposerDraftSent, chatComposerDraftKey } from './chat-composer-draft-store'

type MutableValue<T> = { current: T }

type MessageDeliveryInput = {
  api: PieChatRendererApi
  currentUserId: string
  selectedChannelIdRef: MutableValue<string | null>
  messagesRef: MutableValue<TimelineMessage[]>
  setMessages: Dispatch<SetStateAction<TimelineMessage[]>>
  setError: Dispatch<SetStateAction<string | null>>
}

type MessageDeliveryController = {
  sending: boolean
  sendMessage: (
    body: string,
    opts?: PieSendMessageOptions,
    clientRequestId?: string
  ) => Promise<void>
  retryMessage: (optimisticId: string) => Promise<void>
  dismissFailedMessage: (optimisticId: string) => void
}

function deliveryErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'chat request failed'
}

export function useChatMessageDelivery({
  api,
  currentUserId,
  selectedChannelIdRef,
  messagesRef,
  setMessages,
  setError
}: MessageDeliveryInput): MessageDeliveryController {
  const [sending, setSending] = useState(false)

  const sendMessage = useCallback(
    async (
      body: string,
      opts?: PieSendMessageOptions,
      clientRequestId: string = globalThis.crypto.randomUUID()
    ): Promise<void> => {
      const channelId = selectedChannelIdRef.current
      const trimmed = body.trim()
      const hasAttachment = (opts?.attachmentIds?.length ?? 0) > 0
      if (!channelId || (trimmed.length === 0 && !hasAttachment)) {
        return
      }
      const existing = messagesRef.current.find(
        (message) => message.optimisticId === clientRequestId
      )
      const optimistic =
        existing ??
        createOptimisticMessage(channelId, currentUserId, trimmed, opts, clientRequestId)
      const echo = opts?.threadRootMessageId === undefined
      if (echo) {
        setMessages((current) =>
          current.some((message) => message.optimisticId === clientRequestId)
            ? current.map((message) =>
                message.optimisticId === clientRequestId
                  ? { ...message, pending: true, failed: false }
                  : message
              )
            : [...current, optimistic]
        )
      }
      setSending(true)
      try {
        const sent = await api.sendMessage(channelId, trimmed, opts, clientRequestId)
        if (echo) {
          setMessages((current) =>
            current.map((message) =>
              message.optimisticId === optimistic.optimisticId ? sent : message
            )
          )
          announceChatComposerDraftSent(
            chatComposerDraftKey(currentUserId, channelId),
            clientRequestId
          )
        }
        setError(null)
      } catch (caught) {
        if (echo) {
          setMessages((current) =>
            current.map((message) =>
              message.optimisticId === optimistic.optimisticId
                ? { ...message, pending: false, failed: true }
                : message
            )
          )
        }
        setError(deliveryErrorMessage(caught))
        throw caught
      } finally {
        setSending(false)
      }
    },
    [api, currentUserId, messagesRef, selectedChannelIdRef, setError, setMessages]
  )

  const retryMessage = useCallback(
    async (optimisticId: string): Promise<void> => {
      const target = messagesRef.current.find(
        (message) => message.optimisticId === optimisticId && message.failed
      )
      if (!target?.retryPayload) {
        return
      }
      try {
        await sendMessage(target.retryPayload.body, target.retryPayload.opts, optimisticId)
      } catch {
        // sendMessage preserves the failed row and error; the retry action stays available.
      }
    },
    [messagesRef, sendMessage]
  )

  const dismissFailedMessage = useCallback(
    (optimisticId: string): void => {
      setMessages((current) =>
        current.filter((message) => message.optimisticId !== optimisticId || !message.failed)
      )
    },
    [setMessages]
  )

  return { sending, sendMessage, retryMessage, dismissFailedMessage }
}
