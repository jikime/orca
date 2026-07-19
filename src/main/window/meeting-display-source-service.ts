import { desktopCapturer, ipcMain, type BrowserWindow } from 'electron'
import type { MeetingDisplaySource } from '../../shared/meeting-display-source'

const LIST_CHANNEL = 'meeting-media:list-display-sources'
const SELECT_CHANNEL = 'meeting-media:select-display-source'
const SELECTION_TTL_MS = 60_000

let serviceToken = 0
let activeServiceToken: number | null = null

function sourceKind(id: string): MeetingDisplaySource['kind'] {
  return id.startsWith('screen:') ? 'screen' : 'window'
}

export function registerMeetingDisplaySourceService(mainWindow: BrowserWindow): void {
  const token = ++serviceToken
  activeServiceToken = token
  const webContents = mainWindow.webContents
  let selected: { id: string; expiresAt: number } | null = null

  ipcMain.removeHandler(LIST_CHANNEL)
  ipcMain.removeHandler(SELECT_CHANNEL)
  ipcMain.handle(LIST_CHANNEL, async (event): Promise<MeetingDisplaySource[]> => {
    if (mainWindow.isDestroyed() || event.sender !== webContents) {
      return []
    }
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true
    })
    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      kind: sourceKind(source.id),
      thumbnailDataUrl: source.thumbnail.toDataURL()
    }))
  })
  ipcMain.handle(SELECT_CHANNEL, (event, sourceId: unknown): boolean => {
    if (
      mainWindow.isDestroyed() ||
      event.sender !== webContents ||
      typeof sourceId !== 'string' ||
      sourceId.length === 0 ||
      sourceId.length > 512
    ) {
      return false
    }
    selected = { id: sourceId, expiresAt: Date.now() + SELECTION_TTL_MS }
    return true
  })

  webContents.session.setDisplayMediaRequestHandler(async (request, callback) => {
    const choice = selected
    selected = null
    if (
      mainWindow.isDestroyed() ||
      request.frame !== webContents.mainFrame ||
      !choice ||
      choice.expiresAt < Date.now()
    ) {
      callback({ video: undefined, audio: undefined })
      return
    }
    try {
      // Re-resolve at grant time so a closed window can never be captured using a stale source.
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 0, height: 0 }
      })
      callback({ video: sources.find((source) => source.id === choice.id), audio: undefined })
    } catch (error) {
      console.error('[meeting-media] Failed to resolve display source:', error)
      callback({ video: undefined, audio: undefined })
    }
  })

  mainWindow.on('closed', () => {
    if (activeServiceToken !== token) {
      return
    }
    ipcMain.removeHandler(LIST_CHANNEL)
    ipcMain.removeHandler(SELECT_CHANNEL)
    webContents.session.setDisplayMediaRequestHandler(null)
    activeServiceToken = null
  })
}
