import { describe, expect, it } from 'vitest'
import { insertText, prefixLines, wrapSelection } from './composer-markdown-insert'

describe('composer-markdown-insert', () => {
  it('wraps a selection and keeps the inner text selected', () => {
    // "hello WORLD" — select "WORLD" (indices 6..11)
    const result = wrapSelection('hello WORLD', 6, 11, '**', '**')
    expect(result.value).toBe('hello **WORLD**')
    expect(result.selectionStart).toBe(8)
    expect(result.selectionEnd).toBe(13)
    expect(result.value.slice(result.selectionStart, result.selectionEnd)).toBe('WORLD')
  })

  it('drops the caret between tokens when there is no selection', () => {
    const result = wrapSelection('', 0, 0, '**', '**')
    expect(result.value).toBe('****')
    expect(result.selectionStart).toBe(2)
    expect(result.selectionEnd).toBe(2)
  })

  it('emits an inline <u> tag for underline (markdown has none)', () => {
    const result = wrapSelection('x', 0, 1, '<u>', '</u>')
    expect(result.value).toBe('<u>x</u>')
  })

  it('numbers every selected line for an ordered list', () => {
    const result = prefixLines('one\ntwo\nthree', 0, 13, (index) => `${index + 1}. `)
    expect(result.value).toBe('1. one\n2. two\n3. three')
  })

  it('prefixes a single caret line for an unordered list', () => {
    // caret sits inside "two"; only that line gets the bullet
    const result = prefixLines('one\ntwo\nthree', 5, 5, () => '- ')
    expect(result.value).toBe('one\n- two\nthree')
  })

  it('inserts text at the caret, replacing any selection', () => {
    const result = insertText('ab', 1, 1, '🚀')
    expect(result.value).toBe('a🚀b')
    expect(result.selectionStart).toBe(result.selectionEnd)
    expect(result.value.slice(0, result.selectionStart)).toBe('a🚀')
  })
})
