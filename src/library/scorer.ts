import type { StoredWorkflow } from './types.js'

function loadWeights() {
  const raw = {
    tfidf: parseFloat(process.env['KAIROS_WEIGHT_TFIDF'] ?? ''),
    nodeFingerprint: parseFloat(process.env['KAIROS_WEIGHT_JACCARD'] ?? ''),
    outcome: parseFloat(process.env['KAIROS_WEIGHT_OUTCOME'] ?? ''),
    deploy: parseFloat(process.env['KAIROS_WEIGHT_DEPLOY'] ?? ''),
  }
  const defaults = { tfidf: 0.35, nodeFingerprint: 0.30, outcome: 0.20, deploy: 0.15 }
  const anySet = Object.values(raw).some((v) => !isNaN(v) && v >= 0)
  if (!anySet) return defaults

  // Use provided values (default 0 for unspecified), then normalize to sum=1
  const w = {
    tfidf: !isNaN(raw.tfidf) && raw.tfidf >= 0 ? raw.tfidf : defaults.tfidf,
    nodeFingerprint: !isNaN(raw.nodeFingerprint) && raw.nodeFingerprint >= 0 ? raw.nodeFingerprint : defaults.nodeFingerprint,
    outcome: !isNaN(raw.outcome) && raw.outcome >= 0 ? raw.outcome : defaults.outcome,
    deploy: !isNaN(raw.deploy) && raw.deploy >= 0 ? raw.deploy : defaults.deploy,
  }
  const total = w.tfidf + w.nodeFingerprint + w.outcome + w.deploy
  if (total <= 0) return defaults
  return {
    tfidf: w.tfidf / total,
    nodeFingerprint: w.nodeFingerprint / total,
    outcome: w.outcome / total,
    deploy: w.deploy / total,
  }
}

const WEIGHTS = loadWeights()

const NODE_KEYWORDS: Record<string, string[]> = {
  slack: ['slack', 'slackApi'],
  email: ['gmail', 'sendEmail', 'emailSend', 'emailReadImap'],
  webhook: ['webhook', 'webhookTrigger'],
  schedule: ['scheduleTrigger', 'cron'],
  http: ['httpRequest'],
  sheets: ['googleSheets'],
  github: ['github', 'githubTrigger'],
  telegram: ['telegram', 'telegramTrigger'],
  ai: ['agent', 'openAi', 'lmChatOpenAi', 'lmChatAnthropic', 'chainLlm', 'chainSummarization'],
  memory: ['memoryBufferWindow', 'memoryXata', 'memoryPostgres'],
  vector: ['vectorStoreInMemory', 'vectorStorePinecone', 'vectorStoreQdrant'],
  database: ['postgres', 'mySql', 'redis', 'mongoDb'],
  airtable: ['airtable'],
  notion: ['notion'],
  s3: ['awsS3'],
  code: ['code'],
  merge: ['merge'],
  switch: ['switch'],
  if: ['if'],
  wait: ['wait'],
  rss: ['rssFeedRead', 'rssFeedReadTrigger'],
  form: ['formTrigger'],
  set: ['set'],
  split: ['splitInBatches'],
  filter: ['filter'],
  telegram_trigger: ['telegramTrigger'],
  stripe: ['stripe'],
}

function extractQueryFingerprint(description: string): Set<string> {
  const lower = description.toLowerCase()
  const matches = new Set<string>()

  for (const [keyword, nodeTypes] of Object.entries(NODE_KEYWORDS)) {
    if (lower.includes(keyword)) {
      for (const nt of nodeTypes) matches.add(nt)
    }
  }

  if (/\bevery\b|\bdaily\b|\bhourly\b|\bweekly\b|\bmonthly\b|\bcron\b|\bschedule\b|\bat \d/.test(lower)) {
    matches.add('scheduleTrigger')
  }
  if (/\bwebhook\b|\breceive\b.*\bpost\b|\bpost\b.*\brequest\b/.test(lower)) {
    matches.add('webhook')
  }
  if (/\bchat\b|\bchatbot\b|\bconversation\b/.test(lower)) {
    matches.add('chatTrigger')
  }
  if (/\bai\b|\bllm\b|\bgpt\b|\bclaude\b|\bagent\b|\bsummariz/.test(lower)) {
    matches.add('agent')
  }

  return matches
}

function extractWorkflowFingerprint(w: StoredWorkflow): Set<string> {
  const fp = new Set<string>()
  for (const node of w.workflow.nodes) {
    const bare = node.type.split('.').pop() ?? ''
    fp.add(bare)
  }
  return fp
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let intersection = 0
  for (const item of a) {
    if (b.has(item)) intersection++
  }
  const union = a.size + b.size - intersection
  return union > 0 ? intersection / union : 0
}

function outcomeScore(w: StoredWorkflow): number {
  const stats = w.outcomeStats
  const baseScore = (() => {
    if (!stats || stats.totalUses === 0) return 0.5
    const passRate = stats.firstTryPasses / stats.totalUses
    const avgAttempts = stats.totalAttempts / stats.totalUses
    const attemptPenalty = Math.max(0, 1 - (avgAttempts - 1) * 0.3)
    return passRate * 0.6 + attemptPenalty * 0.4
  })()

  // Blend in runtime reliability if execution traces are available
  const rtr = w.runtimeReliabilityScore
  if (rtr != null) {
    // 70% generation outcome, 30% runtime reliability
    return baseScore * 0.7 + rtr * 0.3
  }

  return baseScore
}

function deployScore(w: StoredWorkflow): number {
  return 1 + Math.log(w.deployCount + 1) * 0.1
}

export interface ScoredEntry {
  workflow: StoredWorkflow
  score: number
  signals: {
    tfidf: number
    nodeFingerprint: number
    outcome: number
    deploy: number
  }
  // Top rules that failed in past builds when this workflow was used as a reference.
  // Derived from outcomeStats.failedRules — sorted by occurrence count descending.
  topFailedRules: Array<{ rule: number; count: number }>
}

function extractTopFailedRules(w: StoredWorkflow, limit = 3): Array<{ rule: number; count: number }> {
  const stats = w.outcomeStats
  if (!stats || Object.keys(stats.failedRules).length === 0) return []
  return Object.entries(stats.failedRules)
    .map(([rule, count]) => ({ rule: parseInt(rule, 10), count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
}

export interface EmbeddingData {
  queryVector: number[]
  workflowVectors: Map<string, number[]>  // workflowId → embedding vector
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    normA += a[i]! * a[i]!
    normB += b[i]! * b[i]!
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom > 0 ? dot / denom : 0
}

// Weights when embeddings are present — cosine gets 25%, other components reduced proportionally
const EMBEDDING_WEIGHTS = { tfidf: 0.30, nodeFingerprint: 0.20, cosine: 0.25, outcome: 0.15, deploy: 0.10 }

export function hybridScore(
  queryTokens: string[],
  queryDescription: string,
  workflows: StoredWorkflow[],
  docTokenArrays: string[][],
  idf: Map<string, number>,
  embeddingData?: EmbeddingData,
): ScoredEntry[] {
  const queryFp = extractQueryFingerprint(queryDescription)
  const ceiling = queryTokens.reduce((sum, qt) => sum + (idf.get(qt) ?? 0), 0) || 1

  return workflows.map((w, i) => {
    const docTokens = docTokenArrays[i]!
    let tfidfRaw = 0
    const docFreq = new Map<string, number>()
    for (const t of docTokens) {
      docFreq.set(t, (docFreq.get(t) ?? 0) + 1)
    }
    for (const qt of queryTokens) {
      const tf = docTokens.length > 0 ? (docFreq.get(qt) ?? 0) / docTokens.length : 0
      const idfVal = idf.get(qt) ?? 0
      tfidfRaw += tf * idfVal
    }
    const tfidf = Math.min(tfidfRaw / ceiling, 1)

    const workflowFp = extractWorkflowFingerprint(w)
    const nodeFingerprint = queryFp.size > 0 ? jaccardSimilarity(queryFp, workflowFp) : 0

    const outcome = outcomeScore(w)
    const deploy = Math.min(deployScore(w), 1.5) / 1.5

    // Use embedding weights only when THIS workflow has a cached vector.
    // Embeddings are computed lazily (a few per search), so during cache warm-up
    // most entries have no vector — scoring them with cosine=0 under reduced
    // keyword weights would bias ranking toward whichever entries got embedded
    // first. Per-workflow fallback keeps un-embedded entries on the BM25 scale.
    const wv = embeddingData?.workflowVectors.get(w.id)
    let score: number
    if (embeddingData && wv) {
      const cosine = cosineSimilarity(embeddingData.queryVector, wv)
      score = Math.min(
        EMBEDDING_WEIGHTS.tfidf * tfidf +
        EMBEDDING_WEIGHTS.nodeFingerprint * nodeFingerprint +
        EMBEDDING_WEIGHTS.cosine * cosine +
        EMBEDDING_WEIGHTS.outcome * outcome +
        EMBEDDING_WEIGHTS.deploy * deploy,
        1,
      )
    } else {
      score = Math.min(
        WEIGHTS.tfidf * tfidf +
        WEIGHTS.nodeFingerprint * nodeFingerprint +
        WEIGHTS.outcome * outcome +
        WEIGHTS.deploy * deploy,
        1,
      )
    }

    return {
      workflow: w,
      score,
      signals: { tfidf, nodeFingerprint, outcome, deploy },
      topFailedRules: extractTopFailedRules(w),
    }
  })
}
