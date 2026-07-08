// Fails any test that reaches a real network call instead of mocking at the class-method
// boundary (the established convention — see tests/unit/pack/pack-builder.test.ts's
// makeMockAnthropic, tests/unit/client-deploy-activation.test.ts's vi.spyOn on
// N8nProvider.prototype). Both the Anthropic SDK and N8nApiClient's fetchWithTimeout
// (src/utils/retry.ts) go through the global fetch, so patching it here is the one place
// that catches an unintended live call regardless of which class made it.
const realFetch = globalThis.fetch

globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
  const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof URL ? args[0].href : (args[0] as Request).url
  throw new Error(
    `Real network call attempted during tests: ${url}\n` +
    'Mock at the class-method boundary instead (vi.spyOn on N8nProvider.prototype / ' +
    'WorkflowDesigner.prototype.design, or a fake Anthropic client per pack-builder.test.ts) ' +
    'rather than letting a real fetch through.',
  )
}) as typeof fetch

export { realFetch }
