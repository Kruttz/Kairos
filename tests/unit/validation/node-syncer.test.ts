import { describe, it, expect } from 'vitest'
import { NodeSyncer } from '../../../src/validation/node-syncer.js'
import type { N8nNodeTypeInfo } from '../../../src/providers/n8n/types.js'

describe('NodeSyncer', () => {
  it('captures a single credential type as credentialType, with no credentialTypes field', () => {
    const syncer = new NodeSyncer()
    const liveNodes: N8nNodeTypeInfo[] = [{
      name: 'n8n-nodes-base.brandNewSingleCredNode',
      displayName: 'Brand New Single-Cred Node',
      version: 1,
      credentials: [{ name: 'onlyOneCredentialApi', required: true }],
    }]

    const result = syncer.sync(liveNodes)
    const entry = result.registry.get('n8n-nodes-base.brandNewSingleCredNode')

    expect(entry?.credentialType).toBe('onlyOneCredentialApi')
    expect(entry?.credentialTypes).toBeUndefined()
  })

  it('captures every credential type for a genuinely new node with multiple options', () => {
    const syncer = new NodeSyncer()
    // Real n8n nodes commonly report multiple valid credential options gated by an
    // authentication-style parameter (confirmed for Gmail/Slack/GitHub/HubSpot/Jira/etc.
    // during the Step 3 ground-truth audit, 2026-07-08) -- this models that shape for a
    // node type not already in DEFAULT_REGISTRY.
    const liveNodes: N8nNodeTypeInfo[] = [{
      name: 'n8n-nodes-base.brandNewMultiCredNode',
      displayName: 'Brand New Multi-Cred Node',
      version: 1,
      credentials: [
        { name: 'brandNewApiKey', required: true },
        { name: 'brandNewOAuth2Api', required: true },
      ],
    }]

    const result = syncer.sync(liveNodes)
    const entry = result.registry.get('n8n-nodes-base.brandNewMultiCredNode')

    // credentialType keeps the first entry for existing consumers of that single field.
    expect(entry?.credentialType).toBe('brandNewApiKey')
    // credentialTypes carries the full set -- what actually fixes the truncation bug.
    expect(entry?.credentialTypes).toEqual(['brandNewApiKey', 'brandNewOAuth2Api'])
  })

  it('does not populate credentialType/credentialTypes when a new node reports no credentials', () => {
    const syncer = new NodeSyncer()
    const liveNodes: N8nNodeTypeInfo[] = [{
      name: 'n8n-nodes-base.brandNewNoCredNode',
      displayName: 'Brand New No-Cred Node',
      version: 1,
    }]

    const result = syncer.sync(liveNodes)
    const entry = result.registry.get('n8n-nodes-base.brandNewNoCredNode')

    expect(entry?.credentialType).toBeUndefined()
    expect(entry?.credentialTypes).toBeUndefined()
  })

  it('does not touch credentialType/credentialTypes for a node already in DEFAULT_REGISTRY (merge only unions typeVersions)', () => {
    const syncer = new NodeSyncer()
    // n8n-nodes-base.gmail is already seeded with credentialType: 'gmailOAuth2'
    // (registry.ts). sync()'s merge path for existing entries only unions
    // safeTypeVersions -- confirmed during the Step 3 audit that this means the
    // multi-credential fix only takes effect for genuinely new node types, not
    // already-known ones like Gmail, which keep their static seed value regardless of
    // what the live instance reports here.
    const liveNodes: N8nNodeTypeInfo[] = [{
      name: 'n8n-nodes-base.gmail',
      displayName: 'Gmail',
      version: [2.1, 2.2],
      credentials: [
        { name: 'googleApi', required: true },
        { name: 'gmailOAuth2', required: true },
      ],
    }]

    const result = syncer.sync(liveNodes)
    const entry = result.registry.get('n8n-nodes-base.gmail')

    expect(entry?.credentialType).toBe('gmailOAuth2') // unchanged static seed value
    expect(entry?.credentialTypes).toBeUndefined() // merge path never sets this field
    expect(entry?.safeTypeVersions).toContain(2.2) // but new typeVersions ARE unioned in
    expect(result.newNodes).toBe(0)
  })

  it('catalogText lists all credential options for a multi-credential node, one for single', () => {
    const syncer = new NodeSyncer()
    const liveNodes: N8nNodeTypeInfo[] = [{
      name: 'n8n-nodes-base.brandNewMultiCredNode',
      displayName: 'Brand New Multi-Cred Node',
      version: 1,
      credentials: [
        { name: 'brandNewApiKey', required: true },
        { name: 'brandNewOAuth2Api', required: true },
      ],
    }]

    const result = syncer.sync(liveNodes)
    expect(result.catalogText).toContain('cred: one of brandNewApiKey, brandNewOAuth2Api')
  })
})
