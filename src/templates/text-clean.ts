// Strips common markdown formatting from freeform text (template descriptions,
// sticky note content) so it reads cleanly as plain text in search corpora and prompts.
export function cleanMarkdownText(raw: string, maxLength = 500): string {
  return raw
    .replace(/#{1,6}\s*/g, '')
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLength)
}
