import { describe, expect, test } from 'bun:test'
import { modelSupportsMaxEffort, resolveAppliedEffort } from '../effort.js'

describe('OpenAI Responses effort support', () => {
  test('keeps max effort for GPT models so the Responses transform can send xhigh', () => {
    expect(modelSupportsMaxEffort('gpt-5.5')).toBe(true)
    expect(resolveAppliedEffort('gpt-5.5', 'max')).toBe('max')
  })
})
