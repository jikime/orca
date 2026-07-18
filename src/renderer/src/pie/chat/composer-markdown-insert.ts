// Pure text transforms for the composer's formatting toolbar. Each returns the
// next textarea value plus the selection to restore, so the caret lands in a
// sensible spot after React re-renders the controlled <textarea>.

export type MarkdownEdit = {
  value: string
  selectionStart: number
  selectionEnd: number
}

// Wraps the current selection with before/after tokens (bold, italic, link, …).
// With no selection the caret is dropped between the tokens so the user types
// inside; with a selection the wrapped text stays selected.
export function wrapSelection(
  value: string,
  start: number,
  end: number,
  before: string,
  after: string
): MarkdownEdit {
  const selected = value.slice(start, end)
  const next = `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`
  const innerStart = start + before.length
  return { value: next, selectionStart: innerStart, selectionEnd: innerStart + selected.length }
}

// Prefixes every line the selection touches (lists, indent). The prefix is a
// function of the line's index so an ordered list can number 1., 2., 3.…
export function prefixLines(
  value: string,
  start: number,
  end: number,
  makePrefix: (lineIndex: number) => string
): MarkdownEdit {
  const lineStart = value.lastIndexOf('\n', start - 1) + 1
  const lineEndIndex = value.indexOf('\n', end)
  const lineEnd = lineEndIndex === -1 ? value.length : lineEndIndex
  const prefixed = value
    .slice(lineStart, lineEnd)
    .split('\n')
    .map((line, index) => `${makePrefix(index)}${line}`)
    .join('\n')
  const next = `${value.slice(0, lineStart)}${prefixed}${value.slice(lineEnd)}`
  return { value: next, selectionStart: lineStart, selectionEnd: lineStart + prefixed.length }
}

// Drops text at the caret (emoji), replacing any selection; caret lands after it.
export function insertText(value: string, start: number, end: number, text: string): MarkdownEdit {
  const next = `${value.slice(0, start)}${text}${value.slice(end)}`
  const caret = start + text.length
  return { value: next, selectionStart: caret, selectionEnd: caret }
}
