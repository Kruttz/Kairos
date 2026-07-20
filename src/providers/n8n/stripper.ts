import type { N8nWorkflow } from '../../types/workflow.js'
import { FORBIDDEN_ON_CREATE, FORBIDDEN_ON_UPDATE } from './types.js'

/**
 * IMPORTANT (found live, 2026-07-19 reliability-suite closeout checkpoint): stripForUpdate()'s
 * blacklist (FORBIDDEN_ON_UPDATE) is NOT, on its own, a complete guarantee that an arbitrary
 * n8n API response is safe to PUT back. It only strips the specific fields already known to be
 * rejected -- it says nothing about fields nobody has hit yet. In practice this has never been
 * a problem because every real write path in this codebase (repair/rollback/replace) first
 * calls N8nProvider.get(), which reconstructs a strict 5-field WHITELIST (name/nodes/
 * connections/settings/tags) before this class ever sees the object -- stripForUpdate() is
 * layered on top of that whitelist, not used as the sole safety net. Calling stripForUpdate()
 * directly on a raw N8nApiClient.getWorkflow() response (skipping N8nProvider.get()) is NOT
 * safe -- confirmed by reproducing exactly this during the closeout checkpoint, which hit a
 * real 400 ("request/body must NOT have additional properties") that the whitelist step alone
 * prevents. Any new production write path should go through N8nProvider.get()/update(), not
 * this class directly.
 */
export class N8nFieldStripper {
  stripForCreate(workflow: N8nWorkflow): N8nWorkflow {
    return this.strip(workflow, FORBIDDEN_ON_CREATE as readonly string[])
  }

  stripForUpdate(workflow: N8nWorkflow): N8nWorkflow {
    return this.strip(workflow, FORBIDDEN_ON_UPDATE as readonly string[])
  }

  private strip(workflow: N8nWorkflow, forbidden: readonly string[]): N8nWorkflow {
    const result = { ...workflow } as unknown as Record<string, unknown>
    for (const field of forbidden) {
      delete result[field]
    }
    return result as unknown as N8nWorkflow
  }
}
