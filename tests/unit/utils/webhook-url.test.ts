import { describe, it, expect } from 'vitest'
import { buildWebhookUrl } from '../../../src/utils/webhook-url.js'

describe('buildWebhookUrl', () => {
  it('joins a base URL with no trailing slash and a path with no leading slash', () => {
    expect(buildWebhookUrl('https://n8n.example.com', 'intake')).toBe('https://n8n.example.com/webhook/intake')
  })

  it('strips a trailing slash from the base URL', () => {
    expect(buildWebhookUrl('https://n8n.example.com/', 'intake')).toBe('https://n8n.example.com/webhook/intake')
  })

  it('does not double up a leading slash already present on the path', () => {
    expect(buildWebhookUrl('https://n8n.example.com', '/intake')).toBe('https://n8n.example.com/webhook/intake')
  })

  it('handles both a trailing slash on base and a leading slash on path', () => {
    expect(buildWebhookUrl('https://n8n.example.com/', '/intake')).toBe('https://n8n.example.com/webhook/intake')
  })

  it('handles neither a trailing slash on base nor a leading slash on path (baseline case)', () => {
    expect(buildWebhookUrl('https://n8n.example.com', 'referral-intake')).toBe('https://n8n.example.com/webhook/referral-intake')
  })

  it('preserves a multi-segment path', () => {
    expect(buildWebhookUrl('https://n8n.example.com', 'a/b/c')).toBe('https://n8n.example.com/webhook/a/b/c')
  })
})
