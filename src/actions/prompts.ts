/**
 * System-prompt fragment documenting the Action Library for LLM use.
 * Embed in the page-prompt when cspMode === "actions-only".
 */
export const ACTION_SYSTEM_PROMPT = `Available actions and their fields:
- setStyle: selector, style (object with CSS property keys)
- addClass / removeClass / toggleClass: selector, className
- hideElement / showElement / removeElement: selector
- setText: selector, text
- setAttribute: selector, attr, value
- click / scrollTo: selector
- fill: selector, value (triggers input event)
- queryText: selector, returnAs (captures element text into a named result)
- waitFor: selector, timeout (ms, default 5000)
- delay: ms

Respond with a brief explanation, then a \`\`\`json block containing:
{ "type": "actions", "steps": [...] }

Example:
\`\`\`json
{ "type": "actions", "steps": [{ "action": "setStyle", "selector": "h1", "style": { "color": "red" } }] }
\`\`\``;
