/**
 * Robustly extract a JSON value from an LLM response.
 * Handles markdown code fences, partial responses, and unescaped quotes
 * inside string values (a common LLM failure mode).
 *
 * Returns the parsed value, or null if no valid JSON could be recovered.
 * Does NOT throw — callers should handle null explicitly.
 */
export function extractJson<T = unknown>(text: string): T | null {
  // Strip markdown code fences
  const cleaned = text
    .replace(/```(?:json|javascript|js|ts|typescript)?([\s\S]*?)```/g, "$1")
    .trim();

  const direct = tryParse<T>(cleaned);
  if (direct !== null) return direct;

  // Extract first {...} or [...] block
  const match = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (!match) return null;

  const extracted = match[0];
  const fromBlock = tryParse<T>(extracted);
  if (fromBlock !== null) return fromBlock;

  // Last resort: repair unescaped quotes then retry
  return tryParse<T>(repairUnescapedQuotes(extracted));
}

function tryParse<T>(str: string): T | null {
  try {
    return JSON.parse(str) as T;
  } catch {
    return null;
  }
}

/**
 * Best-effort repair of unescaped quote characters within JSON string values.
 *
 * Walks character-by-character tracking string context, and escapes any quote
 * that is not followed by a structural JSON character (`,` `}` `]` `:`).
 * Handles backslash escape sequences correctly so already-escaped quotes are
 * not double-escaped.
 *
 * Not 100% for pathological inputs — covers the most common LLM-emitted
 * JSON-quote-escape failures.
 */
export function repairUnescapedQuotes(str: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      result += char;
      escaped = true;
      continue;
    }

    if (char === '"') {
      if (!inString) {
        inString = true;
        result += char;
      } else {
        const rest = str.slice(i + 1).trimStart();
        const next = rest[0];
        if ([",", "}", "]", ":"].includes(next) || rest.length === 0) {
          inString = false;
          result += char;
        } else {
          // Quote inside string value — escape it
          result += '\\"';
        }
      }
      continue;
    }

    result += char;
  }

  return result;
}
