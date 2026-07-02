export interface SubPattern {
  id: string
  name: string
  description: string
  intentTags: string[]
  nodeTypes: string[]
  wiringNotes: string[]
  requiredParameters: Array<{ node: string; param: string; mustBe: string; reason: string }>
  commonMistakes: string[]
  validatorRuleIds: number[]
  connectionSnippet?: string
}

export const SUB_PATTERNS: SubPattern[] = [
  {
    id: 'output-parser',
    name: 'Output Parser (Structured Output)',
    description: 'Wire an outputParser sub-node to a chainLlm so the LLM returns validated structured JSON.',
    intentTags: [
      'output parser', 'structured output', 'json output', 'zod schema', 'format instructions',
      'extract fields', 'extract data', 'parse json', 'structured json', 'json schema',
      'extract structured', 'schema', 'parse response', 'structured response',
    ],
    nodeTypes: [
      '@n8n/n8n-nodes-langchain.chainLlm',
      '@n8n/n8n-nodes-langchain.outputParserStructured',
    ],
    wiringNotes: [
      'The outputParser is a SUB-NODE — it is the SOURCE, pointing TO chainLlm via ai_outputParser connection type.',
      'chainLlm does NOT appear in connections as a source for ai_outputParser.',
    ],
    requiredParameters: [
      {
        node: 'chainLlm',
        param: 'prompt',
        mustBe: 'Must contain the literal string {format_instructions} somewhere in the prompt text.',
        reason: 'n8n injects the schema instructions at that placeholder at runtime. Without it the LLM ignores the schema and output parsing always fails.',
      },
    ],
    commonMistakes: [
      'Connecting the outputParser but omitting {format_instructions} from the chainLlm prompt — the parser connects but output never validates (Rule 99).',
      'Using an expression like ={{ someVar }} as the entire prompt value — expressions skip the {format_instructions} injection; write the prompt as a static string with {format_instructions} embedded.',
    ],
    validatorRuleIds: [99],
    connectionSnippet: `"Output Parser": { "ai_outputParser": [[{"node": "Extract Data", "type": "ai_outputParser", "index": 0}]] }`,
  },

  {
    id: 'split-in-batches-loop',
    name: 'SplitInBatches Loop',
    description: 'Process a large set of items in fixed-size batches with a correct loop-back so all batches execute.',
    intentTags: [
      'split in batches', 'batch', 'batches', 'loop', 'iterate', 'process multiple',
      'process each', 'each item', 'paginate', 'pagination', 'chunk', 'bulk process',
      'process all', 'foreach', 'for each',
    ],
    nodeTypes: [
      'n8n-nodes-base.splitInBatches',
    ],
    wiringNotes: [
      'output-0 = done/finished — connect to whatever runs AFTER all batches complete.',
      'output-1 = loop body — connect to the per-batch processing chain.',
      'The LAST node in the per-batch processing chain MUST loop back to SplitInBatches via main input. Without this, only the first batch ever runs.',
    ],
    requiredParameters: [
      {
        node: 'SplitInBatches',
        param: 'batchSize',
        mustBe: 'A positive integer (e.g. 10, 50, 100).',
        reason: 'Default is 10; always set explicitly so behavior is predictable.',
      },
    ],
    commonMistakes: [
      'No loop-back: forgetting to connect the last processing node back to SplitInBatches input — only the first batch runs (Rule 115).',
      'Reversing output ports: connecting output-0 to the loop body and output-1 to the done step — items are processed zero times and the "done" branch fires immediately.',
      'Branching inside the loop without all paths eventually looping back — items on the un-looped branch are silently dropped.',
    ],
    validatorRuleIds: [115],
    connectionSnippet: `// output-0 → done step; output-1 → processing chain; last processing node → SplitInBatches (loop-back)
"Process Items": { "main": [ [{"node": "Done Step", "type": "main", "index": 0}], [{"node": "Do Work", "type": "main", "index": 0}] ] },
"Do Work": { "main": [ [{"node": "Process Items", "type": "main", "index": 0}] ] }`,
  },

  {
    id: 'http-post-body',
    name: 'HTTP POST / PUT / PATCH with Body',
    description: 'Send an HTTP request that carries a payload — must have sendBody true and a populated body.',
    intentTags: [
      'http post', 'post request', 'http put', 'put request', 'http patch', 'patch request',
      'send data', 'create record', 'create resource', 'update record', 'update resource',
      'api create', 'api update', 'api post', 'submit form', 'send payload',
      'rest api create', 'rest api update', 'webhook post',
    ],
    nodeTypes: [
      'n8n-nodes-base.httpRequest',
    ],
    wiringNotes: [
      'Standard main-flow node — wires via main connections like any other node.',
    ],
    requiredParameters: [
      {
        node: 'HTTP Request',
        param: 'method',
        mustBe: '"POST", "PUT", or "PATCH"',
        reason: 'Determines request method.',
      },
      {
        node: 'HTTP Request',
        param: 'sendBody',
        mustBe: 'true',
        reason: 'Without this flag n8n never sends a request body, regardless of what jsonBody contains.',
      },
      {
        node: 'HTTP Request',
        param: 'jsonBody or bodyParameters',
        mustBe: 'Populated with actual content — never empty when sendBody is true.',
        reason: 'An empty body with sendBody true sends a blank payload, which most APIs reject (pre-delivery check 20).',
      },
    ],
    commonMistakes: [
      'Setting sendBody: true but leaving jsonBody as an empty object {} — sends a blank payload.',
      'Using sendBody: true with specifyBody: "keypair" but an empty bodyParameters array.',
      'Omitting sendBody: true entirely when method is POST — no body is sent at all.',
    ],
    validatorRuleIds: [],
    connectionSnippet: `"parameters": { "method": "POST", "url": "https://api.example.com/items", "sendBody": true, "specifyBody": "json", "jsonBody": "={ \\"name\\": \\"{{$json.name}}\\" }" }`,
  },

  {
    id: 'code-node-output',
    name: 'Code Node Return Format',
    description: 'Code nodes must return an array of item objects for downstream nodes to receive data correctly.',
    intentTags: [
      'code node', 'javascript', 'js code', 'custom logic', 'transform data',
      'code', 'function', 'script', 'custom code', 'write code', 'compute',
      'data transformation', 'format data', 'manipulate data',
    ],
    nodeTypes: [
      'n8n-nodes-base.code',
    ],
    wiringNotes: [
      'Standard main-flow node.',
    ],
    requiredParameters: [
      {
        node: 'Code',
        param: 'jsCode',
        mustBe: 'Must end with: return [{ json: { field: value, ... } }]',
        reason: 'n8n requires the array-of-items format. Returning a plain object, a non-array, or omitting the json key silently breaks all downstream $json references (Rule 103).',
      },
    ],
    commonMistakes: [
      'return { field: value } — missing array wrapper, n8n cannot iterate it.',
      'return [{ field: value }] — missing json key, downstream $json.field always undefined.',
      'return items — only valid if items is already in the correct n8n format; never return raw input items without wrapping.',
      'Leaving the jsCode parameter empty or comment-only — fails pre-delivery check 12.',
    ],
    validatorRuleIds: [103],
    connectionSnippet: `// Correct Code node return:
return [{ json: { result: computedValue, count: items.length } }];

// Multi-item return:
return items.map(item => ({ json: { processed: true, id: item.json.id } }));`,
  },

  {
    id: 'ai-agent-tool-wiring',
    name: 'AI Agent Tool Connections',
    description: 'Wire tool sub-nodes to an AI Agent — direction is always tool→agent, never agent→tool.',
    intentTags: [
      'ai agent', 'agent', 'tool', 'tools', 'function calling', 'agent with tools',
      'calculator', 'web search', 'tool use', 'llm agent', 'autonomous agent',
      'agent tools', 'give agent', 'agent can', 'agent should',
    ],
    nodeTypes: [
      '@n8n/n8n-nodes-langchain.agent',
      '@n8n/n8n-nodes-langchain.lmChatOpenAi',
      '@n8n/n8n-nodes-langchain.lmChatAnthropic',
      '@n8n/n8n-nodes-langchain.toolCalculator',
      '@n8n/n8n-nodes-langchain.toolHttpRequest',
      '@n8n/n8n-nodes-langchain.toolWorkflow',
      '@n8n/n8n-nodes-langchain.toolCode',
    ],
    wiringNotes: [
      'ALL sub-nodes (model, memory, tools) are SOURCES — they appear as keys in connections, pointing TO the agent.',
      'The agent node does NOT appear as a source for any ai_* connection type.',
      'ai_languageModel: language model → agent (required, exactly one)',
      'ai_tool: each tool → agent (one entry per tool)',
      'ai_memory: memory → agent (optional)',
    ],
    requiredParameters: [
      {
        node: 'AI Agent',
        param: 'promptType',
        mustBe: '"define" when using scheduleTrigger or webhook trigger; "auto" only with chatTrigger or formTrigger',
        reason: 'promptType "auto" expects conversational input — with a schedule trigger there is no user message and the agent produces nothing (pre-delivery check 26).',
      },
    ],
    commonMistakes: [
      'Wiring agent → tool (reversed direction) — n8n silently ignores the tool.',
      'Not connecting any ai_languageModel — the agent has no model to run.',
      'Using promptType "auto" with a scheduleTrigger — no chat message exists, agent outputs nothing.',
    ],
    validatorRuleIds: [],
    connectionSnippet: `"OpenAI Chat Model": { "ai_languageModel": [[{"node": "AI Agent", "type": "ai_languageModel", "index": 0}]] },
"Calculator":        { "ai_tool":          [[{"node": "AI Agent", "type": "ai_tool",          "index": 0}]] },
"HTTP Tool":         { "ai_tool":          [[{"node": "AI Agent", "type": "ai_tool",          "index": 1}]] }`,
  },

  {
    id: 'luxon-datetime',
    name: 'Luxon DateTime Expressions',
    description: 'n8n uses Luxon for date/time — not Moment.js. Use the correct API or expressions silently return undefined.',
    intentTags: [
      'date', 'time', 'datetime', 'schedule', 'timestamp', 'today', 'now',
      'format date', 'date format', 'tomorrow', 'yesterday', 'days ago', 'days from now',
      'date difference', 'date comparison', 'current date', 'date string',
      'luxon', 'iso date', 'utc',
    ],
    nodeTypes: [],
    wiringNotes: [
      '$now and $today are Luxon DateTime objects available in any expression field.',
    ],
    requiredParameters: [],
    commonMistakes: [
      'Moment.js syntax: $now.format("YYYY-MM-DD") — Luxon does not have .format(), use .toFormat("yyyy-MM-dd") (lowercase y and d).',
      'Moment.js syntax: $now.add(1, "days") — use $now.plus({days: 1}) instead.',
      'Moment.js syntax: $now.subtract(7, "days") — use $now.minus({days: 7}).',
      'Using $now directly as a string — it is a DateTime object; call .toISO() or .toFormat(...) to get a string.',
      'Uppercase format tokens: "YYYY" and "DD" are Moment-style — Luxon uses "yyyy" and "dd".',
    ],
    validatorRuleIds: [92, 93, 112, 122, 125],
    connectionSnippet: `// Luxon — correct patterns:
$now.toISO()                          // full ISO timestamp
$now.toFormat('yyyy-MM-dd')           // date string (lowercase tokens)
$now.plus({days: 1}).toISO()          // tomorrow
$now.minus({days: 7}).toFormat('yyyy-MM-dd')  // 7 days ago
$now.diff($('Node').first().json.date, 'days').days  // difference in days`,
  },
]
