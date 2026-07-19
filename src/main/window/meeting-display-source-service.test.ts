import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getSourcesMock, handleMock, removeHandlerMock } = vi.hoisted(() => ({
  getSourcesMock: vi.fn(),
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn()
}))

vi.mock('electron', () => ({
  desktopCapturer: { getSources: getSourcesMock },
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock }
}))

import { registerMeetingDisplaySourceService } from './meeting-display-source-service'

describe('meeting display source service', () => {
  beforeEach(() => {
    getSourcesMock.mockReset()
    handleMock.mockReset()
    removeHandlerMock.mockReset()
  })

  it('grants only the explicitly selected source to the owning renderer frame', async () => {
    const source = {
      id: 'window:42:0',
      name: 'Planning',
      thumbnail: { toDataURL: () => 'data:image/png;base64,cGxhbg==' }
    }
    getSourcesMock.mockResolvedValue([source])
    const closedHandlers: (() => void)[] = []
    const setDisplayMediaRequestHandler = vi.fn()
    const mainFrame = {}
    const webContents = {
      mainFrame,
      session: { setDisplayMediaRequestHandler }
    }
    const mainWindow = {
      isDestroyed: vi.fn(() => false),
      webContents,
      on: vi.fn((event: string, handler: () => void) => {
        if (event === 'closed') {
          closedHandlers.push(handler)
        }
      })
    }
    registerMeetingDisplaySourceService(mainWindow as never)

    const list = handleMock.mock.calls.find(
      ([channel]) => channel === 'meeting-media:list-display-sources'
    )?.[1]
    const select = handleMock.mock.calls.find(
      ([channel]) => channel === 'meeting-media:select-display-source'
    )?.[1]
    expect(await list({ sender: {} })).toEqual([])
    expect(await list({ sender: webContents })).toEqual([
      {
        id: source.id,
        name: source.name,
        kind: 'window',
        thumbnailDataUrl: 'data:image/png;base64,cGxhbg=='
      }
    ])
    expect(select({ sender: webContents }, source.id)).toBe(true)

    const displayHandler = setDisplayMediaRequestHandler.mock.calls[0]?.[0]
    const callback = vi.fn()
    await displayHandler({ frame: mainFrame }, callback)
    expect(callback).toHaveBeenCalledWith({ video: source, audio: undefined })

    const denied = vi.fn()
    await displayHandler({ frame: mainFrame }, denied)
    expect(denied).toHaveBeenCalledWith({ video: undefined, audio: undefined })

    closedHandlers.forEach((handler) => handler())
    expect(setDisplayMediaRequestHandler).toHaveBeenLastCalledWith(null)
  })
})
