/**
 * Strip markdown code fences from LLM output.
 * Returns the raw string unchanged if no fence is found.
 */
export function extractCode(text: string): string {
  const match = text.match(/```(?:javascript|js)?\s*\n([\s\S]*?)```/);
  return match ? match[1].trim() : text;
}
