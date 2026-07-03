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

async function processPackage(spec: PackageSpec, catalog: Record<string, NodeCatalogEntry>): Promise<{ ok: number; skipped: number }> {
  const pkgJsonPath = require.resolve(`${spec.packageName}/package.json`)
  const pkgDir = pkgJsonPath.slice(0, -'/package.json'.length)
  const pkgJson = require(pkgJsonPath) as { n8n?: { nodes?: string[] } }
  const nodeFiles = pkgJson.n8n?.nodes ?? []

  let ok = 0
  let skipped = 0

  for (const relPath of nodeFiles) {
    const fullPath = join(pkgDir, relPath)
    const exportName = basename(relPath, '.node.js')
    try {
      const mod = require(fullPath) as Record<string, unknown>
      const ExportedClass = (mod[exportName] ?? Object.values(mod).find((v) => typeof v === 'function')) as (new () => VersionedInstance) | undefined
      if (!ExportedClass) { skipped++; continue }
      const instance = new ExportedClass()
      const desc = resolveDescription(instance)
      if (!desc?.name) { skipped++; continue }
      const type = `${spec.typePrefix}.${desc.name}`
      const entry = extractCatalogEntry(desc)
      if (entry.resources.length === 0 && entry.operations.length === 0) { skipped++; continue }
      catalog[type] = entry
      ok++
    } catch {
      skipped++
    }
  }
  return { ok, skipped }
}

async function main(): Promise<void> {
  const catalog: Record<string, NodeCatalogEntry> = {}
  for (const spec of PACKAGES) {
    const { ok, skipped } = await processPackage(spec, catalog)
    console.log(`${spec.packageName}: ${ok} node types cataloged, ${skipped} skipped (no resource/operation options, or failed to load)`)
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
