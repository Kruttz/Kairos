/**
 * Generates src/validation/node-catalog-generated.ts by requiring the real
 * compiled node classes from n8n-nodes-base and @n8n/n8n-nodes-langchain
 * (installed as devDependencies) and reading their resource/operation option
 * catalogs directly off the instantiated class — not by parsing source text,
 * since many nodes compose properties from shared fragment files that only
 * resolve once the module is actually required.
 *
 * Scope (narrow, per docs/plans/repo-integration-plan.md §10): existence-only
 * catalog of resource/operation values, not a requiredParams/credentialType
 * extractor. n8n's static `required: true` flag is conditionally gated by
 * displayOptions and isn't a reliable requiredness signal without a proper
 * conditional resolver (deferred — see the Phase 5 judgment-call tracker).
 * Similarly, resource and operation option values are recorded as a flat
 * per-node-type union across all resource branches, not paired
 * (resource -> valid operations) — a value valid under one resource might be
 * incorrectly accepted under a different resource with this catalog alone.
 * That's a deliberate, documented limitation, not an oversight.
 *
 * Usage: npx tsx scripts/generate-node-catalog.ts
 */

import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
import { join, basename } from 'node:path'

const require = createRequire(import.meta.url)

interface NodeOptionValue {
  value: string
  name: string
}

interface NodeCatalogEntry {
  resources: string[]
  operations: string[]
}

interface PackageSpec {
  packageName: string
  typePrefix: string
}

const PACKAGES: PackageSpec[] = [
  { packageName: 'n8n-nodes-base', typePrefix: 'n8n-nodes-base' },
  { packageName: '@n8n/n8n-nodes-langchain', typePrefix: '@n8n/n8n-nodes-langchain' },
]

interface NodeDescription {
  name?: string
  properties?: Array<{ name?: string; type?: string; options?: unknown[] }>
}

interface VersionedInstance {
  nodeVersions?: Record<string, { description?: NodeDescription }>
  currentVersion?: number
  description?: NodeDescription
  getNodeType?: (version?: number) => { description?: NodeDescription }
}

function resolveDescription(instance: VersionedInstance): NodeDescription | undefined {
  if (instance.nodeVersions) {
    const resolved = typeof instance.getNodeType === 'function'
      ? instance.getNodeType()
      : instance.nodeVersions[String(instance.currentVersion)]
    return resolved?.description
  }
  return instance.description
}

function extractOptionValues(options: unknown[] | undefined): NodeOptionValue[] {
  if (!Array.isArray(options)) return []
  const out: NodeOptionValue[] = []
  for (const opt of options) {
    if (typeof opt !== 'object' || opt === null) continue
    const o = opt as { value?: unknown; name?: unknown }
    if (typeof o.value === 'string' && typeof o.name === 'string') {
      out.push({ value: o.value, name: o.name })
    }
  }
  return out
}

function extractCatalogEntry(desc: NodeDescription): NodeCatalogEntry {
  const resources = new Set<string>()
  const operations = new Set<string>()
  for (const prop of desc.properties ?? []) {
    if (prop.type !== 'options') continue
    const values = extractOptionValues(prop.options)
    if (prop.name === 'resource') {
      for (const v of values) resources.add(v.value)
    } else if (prop.name === 'operation') {
      for (const v of values) operations.add(v.value)
    }
  }
  return { resources: [...resources].sort(), operations: [...operations].sort() }
}

interface ProcessResult {
  ok: number
  benignSkipped: number
  errors: Array<{ file: string; message: string }>
  packageVersion: string
}

async function processPackage(spec: PackageSpec, catalog: Record<string, NodeCatalogEntry>): Promise<ProcessResult> {
  const pkgJsonPath = require.resolve(`${spec.packageName}/package.json`)
  const pkgDir = pkgJsonPath.slice(0, -'/package.json'.length)
  const pkgJson = require(pkgJsonPath) as { n8n?: { nodes?: string[] }; version?: string }
  const nodeFiles = pkgJson.n8n?.nodes ?? []
  const packageVersion = pkgJson.version ?? 'unknown'

  let ok = 0
  let benignSkipped = 0
  const errors: Array<{ file: string; message: string }> = []

  for (const relPath of nodeFiles) {
    const fullPath = join(pkgDir, relPath)
    const exportName = basename(relPath, '.node.js')
    try {
      const mod = require(fullPath) as Record<string, unknown>
      const ExportedClass = (mod[exportName] ?? Object.values(mod).find((v) => typeof v === 'function')) as (new () => VersionedInstance) | undefined
      if (!ExportedClass) { benignSkipped++; continue }
      const instance = new ExportedClass()
      const desc = resolveDescription(instance)
      if (!desc?.name) { benignSkipped++; continue }
      const type = `${spec.typePrefix}.${desc.name}`
      const entry = extractCatalogEntry(desc)
      if (entry.resources.length === 0 && entry.operations.length === 0) { benignSkipped++; continue }
      catalog[type] = entry
      ok++
    } catch (err) {
      // First line only — Node's "Cannot find module" errors append a multi-line,
      // per-file require stack after the actual message, which would otherwise
      // defeat grouping-by-message below (the real error is identical across
      // files; only the stack trace differs).
      const fullMessage = err instanceof Error ? err.message : String(err)
      const message = fullMessage.split('\n')[0]!
      errors.push({ file: relPath, message })
    }
  }
  return { ok, benignSkipped, errors, packageVersion }
}

function reportErrors(packageName: string, errors: Array<{ file: string; message: string }>): void {
  if (errors.length === 0) return
  // Group by message so one systemic problem (e.g. a missing shared dependency
  // affecting 30 files) prints once with a count, not 30 near-identical lines.
  const byMessage = new Map<string, string[]>()
  for (const { file, message } of errors) {
    const files = byMessage.get(message) ?? []
    files.push(file)
    byMessage.set(message, files)
  }
  console.error(`\n${packageName}: ${errors.length} file(s) threw while loading — this is NOT the same as a node having no resource/operation split, and likely means real node coverage is silently missing from the catalog below:`)
  for (const [message, files] of byMessage) {
    console.error(`  [${files.length}x] ${message}`)
    console.error(`    e.g. ${files[0]}${files.length > 1 ? ` (+ ${files.length - 1} more)` : ''}`)
  }
}

async function main(): Promise<void> {
  const catalog: Record<string, NodeCatalogEntry> = {}
  const sourceVersions: Record<string, string> = {}
  for (const spec of PACKAGES) {
    const { ok, benignSkipped, errors, packageVersion } = await processPackage(spec, catalog)
    sourceVersions[spec.packageName] = packageVersion
    console.log(`${spec.packageName}: ${ok} node types cataloged, ${benignSkipped} skipped (no resource/operation options), ${errors.length} errored while loading`)
    reportErrors(spec.packageName, errors)
  }

  const sortedTypes = Object.keys(catalog).sort()
  const lines: string[] = [
    '// GENERATED FILE — do not edit by hand.',
    '// Produced by scripts/generate-node-catalog.ts from n8n-nodes-base + @n8n/n8n-nodes-langchain.',
    '// Regenerate with: npx tsx scripts/generate-node-catalog.ts',
    '//',
    '// Existence-only catalog: resources/operations are a flat per-node-type union across',
    '// all resource branches, not paired (resource -> valid operations). A value valid under',
    '// one resource might be incorrectly accepted under a different resource with this data',
    '// alone. Full resource-operation pairing requires resolving displayOptions conditionally',
    '// against a concrete parameter state — deferred, see docs/plans/repo-integration-plan.md §10.',
    '',
    'export interface NodeCatalogEntry {',
    '  resources: string[]',
    '  operations: string[]',
    '}',
    '',
    '// Exact versions of the source packages this catalog was generated from — the catalog',
    '// version for provenance purposes IS these version strings, not a separately-tracked',
    '// number that could drift out of sync with what was actually read.',
    `export const NODE_CATALOG_SOURCE_VERSIONS: Record<string, string> = ${JSON.stringify(sourceVersions)}`,
    '',
    'export const NODE_OPERATION_CATALOG: Record<string, NodeCatalogEntry> = {',
  ]
  for (const type of sortedTypes) {
    const entry = catalog[type]!
    lines.push(`  ${JSON.stringify(type)}: ${JSON.stringify(entry)},`)
  }
  lines.push('}')
  lines.push('')

  const outPath = join(import.meta.dirname, '..', 'src', 'validation', 'node-catalog-generated.ts')
  await writeFile(outPath, lines.join('\n'), 'utf-8')
  console.log(`\nWrote ${sortedTypes.length} node types to ${outPath}`)
}

main().catch((err) => {
  console.error('Node catalog generation failed:', err)
  process.exit(1)
})
