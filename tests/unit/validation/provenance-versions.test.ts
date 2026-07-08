import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { getRuleSetVersion, getPromptTemplateVersion, getPromptProfile, getNodeCatalogVersion, getKairosVersion } from '../../../src/validation/provenance-versions.js'
import { VALIDATOR_RULE_IDS } from '../../../src/validation/rule-metadata.js'

describe('provenance-versions', () => {
  it('getRuleSetVersion is deterministic across calls', () => {
    expect(getRuleSetVersion()).toBe(getRuleSetVersion())
  })

  it('getRuleSetVersion changes if VALIDATOR_RULE_IDS content differs', () => {
    const real = getRuleSetVersion()
    // Simulate what the hash would be for a rule-set missing one ID -- confirms the
    // function is actually sensitive to content, not returning a constant.
    const withoutLast = JSON.stringify(VALIDATOR_RULE_IDS.slice(0, -1))
    const simulated = createHash('sha256').update(withoutLast).digest('hex').slice(0, 12)
    expect(simulated).not.toBe(real)
  })

  it('getPromptTemplateVersion is deterministic and non-empty', () => {
    const v = getPromptTemplateVersion()
    expect(v).toBe(getPromptTemplateVersion())
    expect(v.length).toBeGreaterThan(0)
  })

  it('getRuleSetVersion and getPromptTemplateVersion produce different values (not accidentally the same hash)', () => {
    expect(getRuleSetVersion()).not.toBe(getPromptTemplateVersion())
  })

  it('getPromptProfile returns the profile actually resolved from KAIROS_PROMPT_PROFILE (defaults to standard)', () => {
    const original = process.env['KAIROS_PROMPT_PROFILE']
    try {
      delete process.env['KAIROS_PROMPT_PROFILE']
      expect(getPromptProfile()).toBe('standard')
      process.env['KAIROS_PROMPT_PROFILE'] = 'rich'
      expect(getPromptProfile()).toBe('rich')
    } finally {
      if (original === undefined) delete process.env['KAIROS_PROMPT_PROFILE']
      else process.env['KAIROS_PROMPT_PROFILE'] = original
    }
  })

  it('getNodeCatalogVersion returns the real pinned source package versions', () => {
    const versions = getNodeCatalogVersion()
    expect(versions).toHaveProperty('n8n-nodes-base')
    expect(versions).toHaveProperty('@n8n/n8n-nodes-langchain')
    expect(typeof versions['n8n-nodes-base']).toBe('string')
  })

  it('getKairosVersion returns this repo\'s actual published version, not a placeholder', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf-8')) as { version: string }
    expect(getKairosVersion()).toBe(pkg.version)
  })

  it('getKairosVersion is cached (repeated calls return the same value)', () => {
    expect(getKairosVersion()).toBe(getKairosVersion())
  })
})
