import type { IpcMainInvokeEvent } from 'electron'

let trustedRendererWebContentsId: number | null = null

export function setTrustedPieRendererWebContentsId(webContentsId: number | null): void {
  trustedRendererWebContentsId = webContentsId
}

export function clearTrustedPieRendererWebContentsId(webContentsId: number): void {
  if (trustedRendererWebContentsId === webContentsId) {
    trustedRendererWebContentsId = null
  }
}

export function getTrustedPieRendererWebContentsId(): number | null {
  return trustedRendererWebContentsId
}

export function assertTrustedPieMainFrame(event: IpcMainInvokeEvent): void {
  const sender = event.sender
  if (
    trustedRendererWebContentsId === null ||
    sender.id !== trustedRendererWebContentsId ||
    sender.isDestroyed() ||
    sender.getType() !== 'window' ||
    event.senderFrame === null ||
    event.senderFrame !== sender.mainFrame
  ) {
    throw new Error('PIE_IPC_UNTRUSTED_SENDER')
  }
}
