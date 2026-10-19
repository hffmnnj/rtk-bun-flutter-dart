// Byte-preserving whitespace strip only: never reserialize via
// JSON.stringify, which would normalize large integers, -0, exponent
// lexemes, string escapes, duplicate keys, and key order.
const MAX_JSON_BYTES = 4 * 1024 * 1024 // 4 MiB

export function minifyJson(text: string): string {
  if (!text) return text
  const inputBytes = Buffer.byteLength(text)
  if (inputBytes > MAX_JSON_BYTES) return text
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return text
  }
  if (typeof parsed !== "object" || parsed === null) return text
  const parts: string[] = []
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      parts.push(ch)
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
    } else if (ch === '"') {
      inString = true
      parts.push(ch)
    } else if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      continue
    } else {
      parts.push(ch)
    }
  }
  const minified = parts.join("")
  if (Buffer.byteLength(minified) >= inputBytes) return text
  return minified
}
