import type { ActionStep } from "../actions/schema.js";

export type ParsedResponse =
  | { mode: "js"; code: string; explanation: string }
  | { mode: "actions"; steps: ActionStep[]; explanation: string }
  | { mode: "markdown"; text: string };

/**
 * Detect the response mode from LLM bot output.
 *
 * Priority:
 * 1. ```javascript / ```js fence → JS mode
 * 2. ```json fence with { type: "actions", steps: [] } → actions mode
 * 3. Everything else → markdown
 */
export function parseResponse(botText: string): ParsedResponse {
  const jsMatch = botText.match(/```(?:javascript|js)\s*\n([\s\S]*?)```/);
  if (jsMatch) {
    return {
      mode: "js",
      code: jsMatch[1].trim(),
      explanation: botText.slice(0, jsMatch.index).trim(),
    };
  }

  const jsonMatch = botText.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]) as { type?: string; steps?: unknown[] };
      if (parsed?.type === "actions" && Array.isArray(parsed.steps)) {
        return {
          mode: "actions",
          steps: parsed.steps as ActionStep[],
          explanation: botText.slice(0, jsonMatch.index).trim(),
        };
      }
    } catch {
      // Not valid JSON — fall through to markdown
    }
  }

  return { mode: "markdown", text: botText };
}
