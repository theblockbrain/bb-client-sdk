// src/prompt/parse-response.ts
function parseResponse(botText) {
  const jsMatch = botText.match(/```(?:javascript|js)\s*\n([\s\S]*?)```/);
  if (jsMatch) {
    return {
      mode: "js",
      code: jsMatch[1].trim(),
      explanation: botText.slice(0, jsMatch.index).trim()
    };
  }
  const jsonMatch = botText.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (parsed?.type === "actions" && Array.isArray(parsed.steps)) {
        return {
          mode: "actions",
          steps: parsed.steps,
          explanation: botText.slice(0, jsonMatch.index).trim()
        };
      }
    } catch {
    }
  }
  return { mode: "markdown", text: botText };
}

export {
  parseResponse
};
//# sourceMappingURL=chunk-RA424RNZ.js.map