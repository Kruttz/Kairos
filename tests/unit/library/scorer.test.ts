import { describe, it, expect, afterEach, vi } from 'vitest'
import { hybridScore, cosineSimilarity, loadWeights } from '../../../src/library/scorer.js'
import { tokenize, buildSearchCorpus } from '../../../src/library/file-library.js'
import type { StoredWorkflow } from '../../../src/library/types.js'

function makeStored(overrides: Partial<StoredWorkflow> & { description: string }): StoredWorkflow {
  return {
    id: 'test-' + Math.random().toString(36).slice(2),
    workflow: {
      name: overrides.description,
      nodes: overrides.workflow?.nodes ?? [
        { id: '1', parameters: {}, name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
      ],
      connections: {},
    },
    tags: overrides.tags ?? [],
    platform: 'n8n',
    deployCount: overrides.deployCount ?? 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

function buildIdf(queryTokens: string[], docTokenArrays: string[][]): Map<string, number> {
  const docCount = docTokenArrays.length
  const docTokenSets = docTokenArrays.map((tokens) => new Set(tokens))
  const idf = new Map<string, number>()
  for (const token of new Set(queryTokens)) {
    const docsWithToken = docTokenSets.filter((d) => d.has(token)).length
    idf.set(token, Math.log((docCount + 1) / (docsWithToken + 1)) + 1)
  }
  return idf
}

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1)
  })

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0)
  })

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0)
  })

  it('returns 0 for mismatched length vectors', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0)
  })

  it('computes similarity correctly for partial overlap', () => {
    const a = [1, 1, 0]
    const b = [1, 0, 0]
    const result = cosineSimilarity(a, b)
    expect(result).toBeGreaterThan(0)
    expect(result).toBeLessThan(1)
  })
})

describe('hybridScore', () => {
  it('ranks node-matching workflows higher than keyword-only matches', () => {
    const slackWorkflow = makeStored({
      description: 'post message to channel',
      workflow: {
        name: 'Slack Poster',
        nodes: [
          { id: '1', parameters: {}, name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [0, 0] },
          { id: '2', parameters: {}, name: 'Slack', type: 'n8n-nodes-base.slack', typeVersion: 1, position: [200, 0] },
        ],
        connections: {},
      },
    })

    const genericWorkflow = makeStored({
      description: 'send slack notification to team about updates',
    })

    const workflows = [slackWorkflow, genericWorkflow]
    const query = 'send a slack message when webhook fires'
    const queryTokens = tokenize(query)
    const docTokenArrays = workflows.map((w) => tokenize(buildSearchCorpus(w)))
    const idf = buildIdf(queryTokens, docTokenArrays)

    const results = hybridScore(queryTokens, query, workflows, docTokenArrays, idf)
      .sort((a, b) => b.score - a.score)

    expect(results[0]!.workflow.id).toBe(slackWorkflow.id)
    expect(results[0]!.signals.nodeFingerprint).toBeGreaterThan(0)
  })

  it('boosts workflows with successful outcome history', () => {
    const provenWorkflow = makeStored({
      description: 'email reminder workflow',
      outcomeStats: { totalUses: 10, totalAttempts: 10, firstTryPasses: 10, failedRules: {} },
    })

    const unprovenWorkflow = makeStored({
      description: 'email reminder automation',
    })

    const workflows = [provenWorkflow, unprovenWorkflow]
    const query = 'email reminder'
    const queryTokens = tokenize(query)
    const docTokenArrays = workflows.map((w) => tokenize(buildSearchCorpus(w)))
    const idf = buildIdf(queryTokens, docTokenArrays)

    const results = hybridScore(queryTokens, query, workflows, docTokenArrays, idf)
    const proven = results.find((r) => r.workflow.id === provenWorkflow.id)!
    const unproven = results.find((r) => r.workflow.id === unprovenWorkflow.id)!

    expect(proven.signals.outcome).toBeGreaterThan(unproven.signals.outcome)
    expect(proven.score).toBeGreaterThan(unproven.score)
  })

  it('returns all four signal components', () => {
    const wf = makeStored({
      description: 'webhook slack notification',
      workflow: {
        name: 'Test',
        nodes: [
          { id: '1', parameters: {}, name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [0, 0] },
          { id: '2', parameters: {}, name: 'Slack', type: 'n8n-nodes-base.slack', typeVersion: 1, position: [200, 0] },
        ],
        connections: {},
      },
      deployCount: 5,
    })

    const workflows = [wf]
    const query = 'send slack message on webhook'
    const queryTokens = tokenize(query)
    const docTokenArrays = workflows.map((w) => tokenize(buildSearchCorpus(w)))
    const idf = buildIdf(queryTokens, docTokenArrays)

    const results = hybridScore(queryTokens, query, workflows, docTokenArrays, idf)
    expect(results).toHaveLength(1)
    const signals = results[0]!.signals
    expect(signals.tfidf).toBeGreaterThan(0)
    expect(signals.nodeFingerprint).toBeGreaterThan(0)
    expect(signals.outcome).toBeGreaterThanOrEqual(0)
    expect(signals.deploy).toBeGreaterThan(0)
  })

  it('exposes topFailedRules sorted by count descending', () => {
    const wf = makeStored({
      description: 'email notification',
      outcomeStats: {
        totalUses: 5,
        totalAttempts: 8,
        firstTryPasses: 2,
        failedRules: { '99': 4, '55': 2, '24': 1 },
      },
    })

    const workflows = [wf]
    const query = 'email notification'
    const queryTokens = tokenize(query)
    const docTokenArrays = workflows.map((w) => tokenize(buildSearchCorpus(w)))
    const idf = buildIdf(queryTokens, docTokenArrays)

    const results = hybridScore(queryTokens, query, workflows, docTokenArrays, idf)
    expect(results[0]!.topFailedRules).toEqual([
      { rule: 99, count: 4 },
      { rule: 55, count: 2 },
      { rule: 24, count: 1 },
    ])
  })

  it('returns empty topFailedRules when no outcomeStats', () => {
    const wf = makeStored({ description: 'simple workflow' })
    const workflows = [wf]
    const query = 'simple workflow'
    const queryTokens = tokenize(query)
    const docTokenArrays = workflows.map((w) => tokenize(buildSearchCorpus(w)))
    const idf = buildIdf(queryTokens, docTokenArrays)

    const results = hybridScore(queryTokens, query, workflows, docTokenArrays, idf)
    expect(results[0]!.topFailedRules).toEqual([])
  })

  it('uses embedding-based hybrid weights when embeddingData is provided', () => {
    const wf1 = makeStored({ description: 'extract data from API' })
    const wf2 = makeStored({ description: 'send slack message' })
    const workflows = [wf1, wf2]
    const query = 'extract data from api'
    const queryTokens = tokenize(query)
    const docTokenArrays = workflows.map((w) => tokenize(buildSearchCorpus(w)))
    const idf = buildIdf(queryTokens, docTokenArrays)

    // wf1 gets a cosine similarity of 1.0 (identical vector), wf2 gets 0
    const queryVector = [1, 0, 0]
    const embeddingData = {
      queryVector,
      workflowVectors: new Map([[wf1.id, [1, 0, 0]], [wf2.id, [0, 1, 0]]]),
    }

    const withEmbeddings = hybridScore(queryTokens, query, workflows, docTokenArrays, idf, embeddingData)
    const withoutEmbeddings = hybridScore(queryTokens, query, workflows, docTokenArrays, idf)

    // Both methods should rank wf1 higher, but with embeddings the margin is larger
    const wf1WithEmbed = withEmbeddings.find(r => r.workflow.id === wf1.id)!
    const wf1Without = withoutEmbeddings.find(r => r.workflow.id === wf1.id)!
    expect(wf1WithEmbed.score).toBeGreaterThan(wf1Without.score)
  })

  it('falls back to BM25-only weights when no embeddingData provided', () => {
    const wf = makeStored({ description: 'webhook slack notification', deployCount: 5 })
    const workflows = [wf]
    const query = 'slack webhook'
    const queryTokens = tokenize(query)
    const docTokenArrays = workflows.map((w) => tokenize(buildSearchCorpus(w)))
    const idf = buildIdf(queryTokens, docTokenArrays)

    const resultBM25 = hybridScore(queryTokens, query, workflows, docTokenArrays, idf)
    expect(resultBM25[0]!.score).toBeGreaterThan(0)
  })

  it('scores are capped at 1', () => {
    const wf = makeStored({
      description: 'slack slack slack webhook webhook',
      deployCount: 100,
      outcomeStats: { totalUses: 50, totalAttempts: 50, firstTryPasses: 50, failedRules: {} },
    })

    const workflows = [wf]
    const query = 'slack webhook'
    const queryTokens = tokenize(query)
    const docTokenArrays = workflows.map((w) => tokenize(buildSearchCorpus(w)))
    const idf = buildIdf(queryTokens, docTokenArrays)

    const results = hybridScore(queryTokens, query, workflows, docTokenArrays, idf)
    expect(results[0]!.score).toBeLessThanOrEqual(1)
  })
})

const WEIGHT_ENV_VARS = ['KAIROS_WEIGHT_TFIDF', 'KAIROS_WEIGHT_JACCARD', 'KAIROS_WEIGHT_COSINE', 'KAIROS_WEIGHT_OUTCOME', 'KAIROS_WEIGHT_DEPLOY']

describe('loadWeights', () => {
  afterEach(() => {
    for (const key of WEIGHT_ENV_VARS) delete process.env[key]
  })

  it('returns the exact defaults when no weight env vars are set', () => {
    const defaults = { tfidf: 0.35, nodeFingerprint: 0.30, outcome: 0.20, deploy: 0.15 }
    expect(loadWeights(defaults)).toEqual(defaults)
  })

  it('overrides one key and renormalizes the rest to sum to 1', () => {
    process.env['KAIROS_WEIGHT_TFIDF'] = '0.7'
    const result = loadWeights({ tfidf: 0.35, nodeFingerprint: 0.30, outcome: 0.20, deploy: 0.15 })
    const sum = result.tfidf + result.nodeFingerprint + result.outcome + result.deploy
    expect(sum).toBeCloseTo(1, 10)
    // tfidf should now dominate relative to its old 0.35 share
    expect(result.tfidf).toBeGreaterThan(0.35)
  })

  it('falls back to the default for an invalid or negative value', () => {
    process.env['KAIROS_WEIGHT_TFIDF'] = '-1'
    process.env['KAIROS_WEIGHT_JACCARD'] = '0.5'
    const defaults = { tfidf: 0.35, nodeFingerprint: 0.30, outcome: 0.20, deploy: 0.15 }
    const result = loadWeights(defaults)
    // tfidf ignored the negative override and used its default (0.35) before normalizing,
    // while nodeFingerprint's override (0.5) took effect
    const total = defaults.tfidf + 0.5 + defaults.outcome + defaults.deploy
    expect(result.tfidf).toBeCloseTo(defaults.tfidf / total, 10)
    expect(result.nodeFingerprint).toBeCloseTo(0.5 / total, 10)
  })

  it('applies the same override/normalize/fallback behavior to the embedding weight shape (including cosine)', () => {
    process.env['KAIROS_WEIGHT_COSINE'] = '0.6'
    const defaults = { tfidf: 0.30, nodeFingerprint: 0.20, cosine: 0.25, outcome: 0.15, deploy: 0.10 }
    const result = loadWeights(defaults)
    const sum = result.tfidf + result.nodeFingerprint + result.cosine + result.outcome + result.deploy
    expect(sum).toBeCloseTo(1, 10)
    expect(result.cosine).toBeGreaterThan(defaults.cosine)
  })

  it('returns the exact embedding defaults when no weight env vars are set', () => {
    const defaults = { tfidf: 0.30, nodeFingerprint: 0.20, cosine: 0.25, outcome: 0.15, deploy: 0.10 }
    expect(loadWeights(defaults)).toEqual(defaults)
  })
})

describe('module-level WEIGHTS/EMBEDDING_WEIGHTS pick up env vars at real startup', () => {
  afterEach(() => {
    for (const key of WEIGHT_ENV_VARS) delete process.env[key]
    vi.resetModules()
  })

  it('a fresh import of scorer.js computes WEIGHTS from KAIROS_WEIGHT_TFIDF set before load', async () => {
    process.env['KAIROS_WEIGHT_TFIDF'] = '0.7'
    vi.resetModules()
    const fresh = await import('../../../src/library/scorer.js')

    const expected = loadWeights({ tfidf: 0.35, nodeFingerprint: 0.30, outcome: 0.20, deploy: 0.15 })
    expect(fresh.WEIGHTS.tfidf).toBeCloseTo(expected.tfidf, 10)
    expect(fresh.WEIGHTS.tfidf).toBeGreaterThan(0.35)
  })

  it('a fresh import of scorer.js computes EMBEDDING_WEIGHTS from KAIROS_WEIGHT_COSINE set before load', async () => {
    process.env['KAIROS_WEIGHT_COSINE'] = '0.6'
    vi.resetModules()
    const fresh = await import('../../../src/library/scorer.js')

    expect(fresh.EMBEDDING_WEIGHTS.cosine).toBeGreaterThan(0.25)
  })

  it('a fresh import with no weight env vars set matches the hardcoded defaults', async () => {
    vi.resetModules()
    const fresh = await import('../../../src/library/scorer.js')

    expect(fresh.WEIGHTS).toEqual({ tfidf: 0.35, nodeFingerprint: 0.30, outcome: 0.20, deploy: 0.15 })
    expect(fresh.EMBEDDING_WEIGHTS).toEqual({ tfidf: 0.30, nodeFingerprint: 0.20, cosine: 0.25, outcome: 0.15, deploy: 0.10 })
  })
})
