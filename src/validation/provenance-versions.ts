import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VALIDATOR_RULE_IDS } from './rule-metadata.js'
import { SYSTEM_PROMPT_V1 } from '../generation/prompts/v1.js'
import { NODE_CATALOG_SOURCE_VERSIONS } from './node-catalog-generated.js'
import { resolveProfile, type PromptProfile } from '../generation/prompt-builder.js'

function shortHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 12)
}

/**
 * Content-derived rule-set identifier: a hash of the active rule ID list, not a manually
 * incremented constant someone has to remember to bump. Changes whenever a rule is added or
 * removed. Does NOT change when an existing rule's internal logic changes without its ID
 * changing (e.g. today's Rule 58 widening) -- catching that would require hashing the
 * validator's actual source, which isn't reliably available at runtime from a published,
 * compiled package. This is a real, honest limitation, not silently glossed over: this
 * identifier answers "was the rule *set* (which numbers exist) different," not "did
 * validation behavior change in any way."
 */
export function getRuleSetVersion(): string {
  return shortHash(JSON.stringify(VALIDATOR_RULE_IDS))
}

/**
 * Content-derived hash of the STATIC BASE system prompt template (SYSTEM_PROMPT_V1) only --
 * NOT a hash of what was actually sent to the model for any given build. PromptBuilder.build()
 * (src/generation/prompt-builder.ts) assembles the real prompt dynamically per request: the
 * node catalog gets substituted in, and reference-workflow/pattern/memory/failure-rate blocks
 * get appended depending on the match mode and prompt profile. Hashing that full assembled
 * result would vary per build by design (different descriptions match different library
 * workflows) rather than tracking a stable "version" of anything -- so this intentionally
 * stays scoped to the one part that IS a fixed, versionable artifact: the base template
 * string. Always in sync with that base template by construction (hashes the live constant,
 * never a manually bumped label). See getPromptProfile() for the other input that
 * deterministically affects prompt assembly and is cheap to record exactly.
 */
export function getPromptTemplateVersion(): string {
  return shortHash(SYSTEM_PROMPT_V1)
}

/**
 * Which KAIROS_PROMPT_PROFILE ('minimal' | 'standard' | 'rich') shaped this build's prompt
 * assembly -- recorded alongside getPromptTemplateVersion() since profile is a real, coarse
 * input to what actually got sent, distinct from (and not captured by) the base-template hash.
 */
export function getPromptProfile(): PromptProfile {
  return resolveProfile()
}

/**
 * Node catalog identifier: the exact source package versions the catalog was generated from
 * (baked into node-catalog-generated.ts by scripts/generate-node-catalog.ts), not a separate
 * number -- this can't drift out of sync with what was actually read, because it IS what was
 * actually read.
 */
export function getNodeCatalogVersion(): Record<string, string> {
  return NODE_CATALOG_SOURCE_VERSIONS
}

let cachedKairosVersion: string | null = null

/**
 * Walks up from startDir looking for the nearest package.json. Deliberately not a fixed
 * number of `..` segments -- this file's own depth under src/ (two levels) doesn't match its
 * depth under the flat dist/ tsup produces (one level, alongside mcp-server.js, which is why
 * mcp-server.ts's __dirname/'..' pattern isn't safe to copy verbatim here). Walking up covers
 * both dev (running against src/*.ts directly) and the published build without hardcoding
 * either depth. Stops at 10 levels as a sanity bound against an unexpected filesystem layout,
 * not a real limit either environment should ever approach.
 */
function findPackageJson(startDir: string): string | null {
  let dir = startDir
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/**
 * The published @kairos-sdk/core version this code is running as, read from the nearest
 * package.json above this file. Cached after the first read since it can't change during a
 * running process. Falls back to 'unknown' rather than throwing -- provenance fields degrade
 * honestly, they don't abort a build over a missing version string.
 */
export function getKairosVersion(): string {
  if (cachedKairosVersion !== null) return cachedKairosVersion
  try {
    const startDir = dirname(fileURLToPath(import.meta.url))
    const pkgPath = findPackageJson(startDir)
    const pkg = pkgPath ? (JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string }) : null
    cachedKairosVersion = pkg?.version ?? 'unknown'
  } catch {
    cachedKairosVersion = 'unknown'
  }
  return cachedKairosVersion
}
