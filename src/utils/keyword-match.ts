// Word-boundary keyword matching for intent/pattern classification.
// Plain substring matching false-positives badly: 'ai' ⊂ "email"/"daily"/"wait",
// 'date' ⊂ "update"/"validate", 'now' ⊂ "know", 'code' ⊂ "encode".
const regexCache = new Map<string, RegExp>()

/**
 * True if `keyword` appears in `text` as a whole word (or whole phrase —
 * multi-word keywords like "send email" are matched with boundaries at both ends).
 * Both arguments are expected to be lowercase.
 */
export function containsKeyword(text: string, keyword: string): boolean {
  let re = regexCache.get(keyword)
  if (!re) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    re = new RegExp(`\\b${escaped}\\b`)
    regexCache.set(keyword, re)
  }
  return re.test(text)
}
