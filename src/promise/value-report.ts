import { generatePromiseReport, type PromiseReportData } from './report.js'
import type { ImpactAssumptions, ValueLineItem, AutomationValueReport } from './value-types.js'

/**
 * Automation P&L / Value Report (roadmap item 13, docs/plans/contract-evolution-ops-roadmap-plan.md
 * §3, item 13). Pure, no I/O -- `buildAutomationValueReport()`/`generateAutomationValueReport()`
 * are the only exports the rest of this item depends on.
 *
 * The single guarantee this whole module exists to make: no dollar or time figure is ever
 * computed without an explicit, present, human-supplied assumption for that specific multiplier.
 * `count > 0` never gates whether a line item appears -- only whether the ASSUMPTION field
 * itself was supplied. Omitting a line item because the count happened to be zero this window
 * would be a surprising, inconsistent special case; a supplied assumption always produces a
 * visible line, even a "0 x N = 0" one, so the report's own shape never silently changes window
 * to window.
 */

export function validateImpactAssumptions(assumptions: ImpactAssumptions): string[] {
  const issues: string[] = []
  const hasDollarField = assumptions.dollarValuePerResolvedException !== undefined || assumptions.dollarValuePerAvoidedMiss !== undefined
  if (hasDollarField && !assumptions.currency) {
    issues.push('currency is required when dollarValuePerResolvedException or dollarValuePerAvoidedMiss is present -- Kairos never assumes a currency on your behalf.')
  }
  return issues
}

function minutesLineItem(label: string, count: number, perUnit: number | undefined, unitLabel: string): ValueLineItem | null {
  if (perUnit === undefined) return null
  const total = count * perUnit
  return { label, formula: `${count} ${unitLabel}(s) x ${perUnit} min = ${total} min`, count, perUnitAssumption: perUnit, total, unit: 'minutes' }
}

function dollarLineItem(label: string, count: number, perUnit: number | undefined, currency: string | undefined, unitLabel: string): ValueLineItem | null {
  if (perUnit === undefined || !currency) return null // defensive -- validateImpactAssumptions() is the real gate; never invent a currency here
  const total = count * perUnit
  return { label, formula: `${count} ${unitLabel}(s) x ${perUnit} ${currency} = ${total} ${currency}`, count, perUnitAssumption: perUnit, total, unit: 'currency' }
}

/**
 * `assumptions` should already have passed `validateImpactAssumptions()` -- this function stays
 * defensive regardless (a dollar assumption with no currency simply produces no line item for
 * that field, never a fabricated currency), matching `checkSlaCompliance()`'s own "filters
 * defensively regardless" convention rather than trusting the caller blindly.
 */
export function buildAutomationValueReport(reportData: PromiseReportData, assumptions?: ImpactAssumptions): AutomationValueReport {
  if (!assumptions) return { observed: reportData }

  const keptCount = reportData.instanceCounts.kept
  const resolvedCount = reportData.resolvedExceptionCount

  const lineItems = [
    minutesLineItem('Time saved on kept promise instances', keptCount, assumptions.minutesSavedPerKeptInstance, 'kept instance'),
    minutesLineItem('Time saved on resolved exceptions', resolvedCount, assumptions.minutesSavedPerResolvedException, 'resolved exception'),
    dollarLineItem('Dollar value of resolved exceptions', resolvedCount, assumptions.dollarValuePerResolvedException, assumptions.currency, 'resolved exception'),
    dollarLineItem('Dollar value of misses avoided (resolved before becoming a miss)', resolvedCount, assumptions.dollarValuePerAvoidedMiss, assumptions.currency, 'resolved exception'),
  ].filter((item): item is ValueLineItem => item !== null)

  if (lineItems.length === 0) return { observed: reportData }

  return {
    observed: reportData,
    estimatedValue: {
      lineItems,
      assumptionsUsed: assumptions,
      disclaimer: `Estimated from assumptions entered by ${assumptions.enteredBy ?? 'a human'}${assumptions.enteredAt ? ` on ${assumptions.enteredAt}` : ''}, not measured directly. These are estimates built from real observed counts above multiplied by a human-supplied assumption -- not a fact Kairos itself confirmed. See the Observed section above for what evidence actually supports.`,
    },
  }
}

export function generateAutomationValueReport(report: AutomationValueReport): string {
  const lines: string[] = [generatePromiseReport(report.observed)]

  if (report.estimatedValue) {
    lines.push('')
    lines.push(`## Estimated Value`)
    lines.push('')
    lines.push(`> ${report.estimatedValue.disclaimer}`)
    lines.push('')
    const currency = report.estimatedValue.assumptionsUsed.currency
    lines.push(`| Line item | Formula | Total |`)
    lines.push(`|---|---|---|`)
    for (const item of report.estimatedValue.lineItems) {
      const totalLabel = item.unit === 'currency' ? `${item.total} ${currency}` : `${item.total} ${item.unit}`
      lines.push(`| ${item.label} | ${item.formula} | ${totalLabel} |`)
    }
  }

  return lines.join('\n')
}
