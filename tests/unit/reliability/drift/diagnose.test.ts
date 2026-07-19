import { describe, it, expect } from 'vitest'
import { diagnoseDrift, diagnoseAll } from '../../../../src/reliability/drift/diagnose.js'
import type { DriftCheckFinding } from '../../../../src/reliability/drift/checks.js'

const CONTEXT = { workflowId: 'wf-123', workflowName: 'Missed Call Text-Back' }

function makeFinding(overrides: Partial<DriftCheckFinding>): DriftCheckFinding {
  return {
    id: 'D2',
    status: 'drifting',
    severity: 'warning',
    summary: 'test summary',
    evidence: {},
    ...overrides,
  }
}

describe('diagnoseDrift', () => {
  it('returns null for insufficient_data, not_applicable, and healthy -- nothing to diagnose', () => {
    for (const status of ['insufficient_data', 'not_applicable', 'healthy'] as const) {
      const finding = makeFinding({ status })
      expect(diagnoseDrift(finding, CONTEXT)).toBeNull()
    }
  })

  it('carries workflowId, workflowName, and checkId through -- the "affected workflow" requirement', () => {
    const finding = makeFinding({ id: 'D9', evidence: { originalBuildHash: 'a', liveExportHash: 'b' } })
    const diagnosis = diagnoseDrift(finding, CONTEXT)
    expect(diagnosis?.workflowId).toBe('wf-123')
    expect(diagnosis?.workflowName).toBe('Missed Call Text-Back')
    expect(diagnosis?.checkId).toBe('D9')
  })

  it('every diagnosis includes all six required fields', () => {
    const finding = makeFinding({ id: 'D9', evidence: { originalBuildHash: 'a', liveExportHash: 'b' } })
    const diagnosis = diagnoseDrift(finding, CONTEXT)!
    expect(diagnosis.evidence).toBeDefined()
    expect(diagnosis.causeStatement).toBeTruthy()
    expect(diagnosis.recommendedAction).toBeTruthy()
    expect(diagnosis.repairClass).toMatch(/^(mechanical|escalation_only)$/)
    expect(diagnosis.confidence).toMatch(/^(high|medium|low)$/)
    expect(diagnosis.checkId).toBeTruthy()
    expect(diagnosis.workflowId).toBeTruthy()
  })

  describe('confidence-tiered language, exact wording', () => {
    it('high confidence renders "Likely caused by: ..."', () => {
      const finding = makeFinding({ id: 'D9', evidence: { originalBuildHash: 'a', liveExportHash: 'b' } })
      const diagnosis = diagnoseDrift(finding, CONTEXT)!
      expect(diagnosis.confidence).toBe('high')
      expect(diagnosis.causeStatement.startsWith('Likely caused by: ')).toBe(true)
    })

    it('medium confidence renders "Possible cause: ..."', () => {
      const finding = makeFinding({ id: 'D2' })
      const diagnosis = diagnoseDrift(finding, CONTEXT)!
      expect(diagnosis.confidence).toBe('medium')
      expect(diagnosis.causeStatement.startsWith('Possible cause: ')).toBe(true)
    })

    it('low confidence renders exactly "Observed symptom; cause unknown." with no cause text leaked', () => {
      const finding = makeFinding({
        id: 'D1',
        evidenceQuality: 'generic',
        evidence: { newlyErroringNodes: [{ name: 'Code', errorType: 'UnknownError' }] },
      })
      const diagnosis = diagnoseDrift(finding, CONTEXT)!
      expect(diagnosis.confidence).toBe('low')
      expect(diagnosis.causeStatement).toBe('Observed symptom; cause unknown.')
    })
  })

  describe('D1 confidence follows evidenceQuality, not a fixed per-check tier', () => {
    it('specific evidenceQuality -> high confidence, mechanical repair class', () => {
      const finding = makeFinding({
        id: 'D1',
        evidenceQuality: 'specific',
        evidence: { newlyErroringNodes: [{ name: 'HTTP Request', errorType: 'NodeApiError', httpCode: '429' }] },
      })
      const diagnosis = diagnoseDrift(finding, CONTEXT)!
      expect(diagnosis.confidence).toBe('high')
      expect(diagnosis.repairClass).toBe('mechanical')
      expect(diagnosis.affectedNodes).toEqual(['HTTP Request'])
    })

    it('generic evidenceQuality -> low confidence, escalation_only', () => {
      const finding = makeFinding({
        id: 'D1',
        evidenceQuality: 'generic',
        evidence: { newlyErroringNodes: [{ name: 'Code', errorType: 'UnknownError' }] },
      })
      const diagnosis = diagnoseDrift(finding, CONTEXT)!
      expect(diagnosis.confidence).toBe('low')
      expect(diagnosis.repairClass).toBe('escalation_only')
    })
  })

  describe('repairClass matches the plan\'s mechanical/escalation_only design (8.2)', () => {
    it.each([
      ['D2', 'escalation_only'],
      ['D3', 'escalation_only'],
      ['D4', 'escalation_only'],
      ['D5', 'escalation_only'],
      ['D6', 'escalation_only'],
      ['D7', 'escalation_only'],
      ['D8', 'mechanical'],
      ['D9', 'mechanical'],
    ] as const)('%s -> %s', (id, expected) => {
      const finding = makeFinding({ id, evidence: id === 'D9' ? { originalBuildHash: 'a', liveExportHash: 'b' } : {} })
      const diagnosis = diagnoseDrift(finding, CONTEXT)!
      expect(diagnosis.repairClass).toBe(expected)
    })
  })

  describe('affectedNodes: present for node-level checks, absent for workflow/payload-level checks', () => {
    it('D1, D3, D4, D7 carry affectedNodes', () => {
      const cases: Array<[DriftCheckFinding['id'], Record<string, unknown>]> = [
        ['D1', { newlyErroringNodes: [{ name: 'A', errorType: 'X' }] }],
        ['D3', { missingCoreNodes: ['B'] }],
        ['D4', { newNodes: ['C'] }],
        ['D7', { anomalousNodes: [{ name: 'D' }] }],
      ]
      for (const [id, evidence] of cases) {
        const diagnosis = diagnoseDrift(makeFinding({ id, evidence }), CONTEXT)!
        expect(diagnosis.affectedNodes).toBeDefined()
        expect(diagnosis.affectedNodes!.length).toBeGreaterThan(0)
      }
    })

    it('D2, D5, D6, D8, D9 do not carry affectedNodes -- honest absence, not a fabricated empty array', () => {
      const ids: DriftCheckFinding['id'][] = ['D2', 'D5', 'D6', 'D8', 'D9']
      for (const id of ids) {
        const evidence = id === 'D9' ? { originalBuildHash: 'a', liveExportHash: 'b' } : {}
        const diagnosis = diagnoseDrift(makeFinding({ id, evidence }), CONTEXT)!
        expect(diagnosis.affectedNodes).toBeUndefined()
      }
    })
  })
})

describe('diagnoseAll', () => {
  it('skips non-drifting findings and returns diagnoses only for drifting ones', () => {
    const findings: DriftCheckFinding[] = [
      makeFinding({ id: 'D1', status: 'healthy' }),
      makeFinding({ id: 'D2', status: 'insufficient_data' }),
      makeFinding({ id: 'D3', status: 'not_applicable' }),
      makeFinding({ id: 'D9', status: 'drifting', evidence: { originalBuildHash: 'a', liveExportHash: 'b' } }),
    ]
    const diagnoses = diagnoseAll(findings, CONTEXT)
    expect(diagnoses).toHaveLength(1)
    expect(diagnoses[0]!.checkId).toBe('D9')
  })
})
