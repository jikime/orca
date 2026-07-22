import { describe, expect, it } from 'vitest'
import { broadcastMentionOptions } from './message-broadcast-mentions'

describe('broadcastMentionOptions', () => {
  it('recognizes standalone channel and here mentions', () => {
    expect(broadcastMentionOptions('Heads up @channel, @here!')).toEqual({
      mentionChannel: true,
      mentionHere: true
    })
  })

  it('does not notify for partial words or code samples', () => {
    expect(broadcastMentionOptions('email@channel.test `@here`\n```\n@channel\n```')).toEqual({
      mentionChannel: false,
      mentionHere: false
    })
  })
})
