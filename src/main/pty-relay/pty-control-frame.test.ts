import { expect, test } from 'vitest'
import {
  decodePtyControlFrame,
  encodePtyControlFrame,
  PTY_CONTROL_FRAME_KIND
} from './pty-control-frame'

const enc = (text: string): Uint8Array => new TextEncoder().encode(text)
const dec = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

test('an input frame round-trips kind and payload', () => {
  const framed = encodePtyControlFrame(PTY_CONTROL_FRAME_KIND.input, enc('ls -la\n'))
  const decoded = decodePtyControlFrame(framed)
  expect(decoded?.kind).toBe(PTY_CONTROL_FRAME_KIND.input)
  expect(dec(decoded!.payload)).toBe('ls -la\n')
})

test('an empty buffer decodes to null (never reaches the PTY)', () => {
  expect(decodePtyControlFrame(new Uint8Array(0))).toBeNull()
})

test('an unknown kind decodes to null (never reaches the PTY)', () => {
  const framed = new Uint8Array([0x7f, 1, 2, 3])
  expect(decodePtyControlFrame(framed)).toBeNull()
})

test('an input frame with an empty payload is still valid (bare keystroke edge)', () => {
  const framed = encodePtyControlFrame(PTY_CONTROL_FRAME_KIND.input, new Uint8Array(0))
  const decoded = decodePtyControlFrame(framed)
  expect(decoded?.kind).toBe(PTY_CONTROL_FRAME_KIND.input)
  expect(decoded!.payload).toHaveLength(0)
})
