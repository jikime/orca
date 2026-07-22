import { afterEach, describe, expect, it, vi } from 'vitest'

const { fromIdMock, sendMock } = vi.hoisted(() => ({
  fromIdMock: vi.fn(),
  sendMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  webContents: { fromId: fromIdMock }
}))

vi.mock('../pie-chat/chat-control-plane-client', () => ({
  deleteMessage: vi.fn(),
  editMessage: vi.fn(),
  listChannels: vi.fn(),
  listMessages: vi.fn(),
  markRead: vi.fn(),
  sendMessage: vi.fn(),
  sendTyping: vi.fn()
}))

import { PIE_CHAT_MESSAGES_CHANGED_CHANNEL } from '../../shared/pie-chat-ipc-channels'
import { emitPieChatMessagesChanged } from './pie-chat'
import { setTrustedPieRendererWebContentsId } from './pie-renderer-trust'

const ORG_A = '20000000-0000-4000-8000-000000000001'
const ORG_B = '20000000-0000-4000-8000-000000000002'

afterEach(() => {
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
})

describe('Pie chat realtime change batching', () => {
  it('emits one renderer nudge per organization for a replay burst', () => {
    vi.useFakeTimers()
    sendMock.mockReset()
    fromIdMock.mockReturnValue({ isDestroyed: () => false, send: sendMock })
    setTrustedPieRendererWebContentsId(42)

    emitPieChatMessagesChanged(ORG_A)
    emitPieChatMessagesChanged(ORG_A)
    emitPieChatMessagesChanged(ORG_A)
    emitPieChatMessagesChanged(ORG_B)

    expect(sendMock).not.toHaveBeenCalled()
    vi.runOnlyPendingTimers()
    expect(sendMock).toHaveBeenCalledTimes(2)
    expect(sendMock).toHaveBeenCalledWith(PIE_CHAT_MESSAGES_CHANGED_CHANNEL, {
      type: 'chat.messages-changed',
      organizationId: ORG_A
    })
    expect(sendMock).toHaveBeenCalledWith(PIE_CHAT_MESSAGES_CHANGED_CHANNEL, {
      type: 'chat.messages-changed',
      organizationId: ORG_B
    })
  })
})
