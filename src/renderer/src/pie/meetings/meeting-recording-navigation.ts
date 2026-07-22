type RecordingSeekListener = (milliseconds: number) => void

const listeners = new Set<RecordingSeekListener>()

export function requestMeetingRecordingSeek(milliseconds: number): void {
  for (const listener of listeners) {
    listener(milliseconds)
  }
}

export function subscribeMeetingRecordingSeek(listener: RecordingSeekListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
