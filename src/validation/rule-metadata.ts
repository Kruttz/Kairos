export type PipelineStage = 'node_generation' | 'credential_injection' | 'connection_wiring' | 'workflow_structure' | 'expression_syntax'

export const VALIDATOR_RULE_IDS: number[] = Array.from({ length: 34 }, (_, i) => i + 1)

export const RULE_PIPELINE_STAGES: Record<number, PipelineStage> = {
  1: 'node_generation',
  2: 'node_generation',
  3: 'node_generation',
  4: 'node_generation',
  5: 'node_generation',
  6: 'node_generation',
  7: 'node_generation',
  8: 'node_generation',
  9: 'connection_wiring',
  10: 'connection_wiring',
  11: 'connection_wiring',
  12: 'workflow_structure',
  13: 'node_generation',
  14: 'workflow_structure',
  15: 'node_generation',
  16: 'node_generation',
  17: 'credential_injection',
  18: 'connection_wiring',
  19: 'node_generation',
  20: 'connection_wiring',
  21: 'workflow_structure',
  22: 'workflow_structure',
  23: 'node_generation',
  24: 'expression_syntax',
  25: 'expression_syntax',
  26: 'expression_syntax',
  27: 'node_generation',
  28: 'node_generation',
  29: 'node_generation',
  30: 'node_generation',
  31: 'node_generation',
  32: 'node_generation',
  33: 'node_generation',
  34: 'node_generation',
}

export interface RuleExample {
  bad: string
  good: string
}

export const RULE_EXAMPLES: Record<number, RuleExample> = {
  17: {
    bad:  '"credentials": { "slackOAuth2Api": "my-token" }',
    good: '"credentials": { "slackOAuth2Api": { "id": "placeholder-id", "name": "My Slack OAuth" } }',
  },
  24: {
    bad: '$node["Fetch Data"].json.email',
    good: "$('Fetch Data').item.json.email",
  },
  25: {
    bad: '$json.items[0].email',
    good: '$json.email',
  },
  26: {
    bad: "$('Fetch Data').json.email",
    good: "$('Fetch Data').first().json.email",
  },
}

export const RULE_MITIGATIONS: Record<number, string> = {
  1: 'Provide a non-empty workflow name string',
  2: 'Include at least one node in the nodes array',
  3: 'Every node must have a unique UUID v4 string as its id field',
  4: 'Ensure all node ids are unique — no two nodes can share the same id',
  5: 'Every node must have a non-empty type string',
  6: 'Every node must have a positive integer typeVersion',
  7: 'Every node must have a position array of exactly [x, y] numbers',
  8: 'Every node must have a non-empty name string',
  9: 'connections must be a plain object (use {} if no connections)',
  10: 'Every node name in connections (source and target) must exactly match a name in the nodes array',
  11: 'Every non-trigger node should have at least one incoming connection',
  12: 'Remove forbidden fields: id, active, createdAt, updatedAt, versionId, meta, tags — these are server-assigned',
  13: 'workflow.settings must be a plain object if present',
  14: 'Include at least one trigger node (e.g. scheduleTrigger, webhookTrigger, manualTrigger, or service-specific)',
  15: 'Node type strings must be fully qualified: "n8n-nodes-base.httpRequest" not just "httpRequest"',
  16: 'All node names must be unique within the workflow',
  17: 'Each credential entry must be keyed by credential type with an object value: { "slackOAuth2Api": { "id": "placeholder-id", "name": "My Credential" } } — the key is the credential type, the value has id and name strings',
  18: 'AI sub-nodes (languageModel, memory, tool) must be the CONNECTION SOURCE pointing TO the agent — not the reverse',
  19: 'Use known safe typeVersion values for each node type',
  20: 'Remove connection cycles — ensure no node can reach itself through the connection graph',
  21: 'When using webhook with responseMode "responseNode", include a respondToWebhook node in the flow',
  22: 'Ensure all required parameters are set for each node type (e.g. webhook needs httpMethod and path)',
  23: 'Use node types that exist in the n8n registry — check with kairos_sync',
  24: 'Use modern accessor syntax: $("NodeName").item.json.field instead of deprecated $node["NodeName"].json.field',
  25: 'Access item fields directly with $json.field — n8n flattens items automatically, do not use $json.items[0]',
  26: 'Use $("NodeName").first().json.field or $("NodeName").all() — bare $("NodeName").json without .first() or .all() throws at runtime',
  27: 'Replace placeholder URLs with your actual API endpoint — do not use "example.com" or "YOUR_URL" patterns',
  28: 'Add executable code to the code node — empty or comment-only code nodes do nothing at runtime',
  29: 'Set the channel parameter for Slack message operations (channelId with __rl object, or channel as string)',
  30: 'Set the to parameter for Gmail send operations with at least one recipient email address',
  31: 'Add at least one condition to the if node — conditions.conditions array must be non-empty',
  32: 'Add field assignments to the set node — assignments.assignments array must be non-empty for typeVersion 3.x',
  33: 'Add at least one schedule rule to scheduleTrigger — rule.interval array must have at least one entry',
  34: 'Webhook path must be a relative path without spaces, leading slashes, or protocol prefixes (e.g. "my-hook")',
}
