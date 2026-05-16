import { b as ActionStep, a as ActionResult } from '../schema-BJs6_Xa5.js';
export { A as AVAILABLE_ACTIONS } from '../schema-BJs6_Xa5.js';

/**
 * Execute a list of Action-Library steps against a DOM document.
 * Pure DOM — no eval, no new Function(). CSP-safe on all pages.
 *
 * Self-contained by design: when serialized via chrome.scripting.executeScript({ func }),
 * no external closures or imports are captured. The waitForEl helper is nested inline.
 */
declare function runActions(steps: ActionStep[], doc?: Document): Promise<ActionResult>;

/**
 * System-prompt fragment documenting the Action Library for LLM use.
 * Embed in the page-prompt when cspMode === "actions-only".
 */
declare const ACTION_SYSTEM_PROMPT = "Available actions and their fields:\n- setStyle: selector, style (object with CSS property keys)\n- addClass / removeClass / toggleClass: selector, className\n- hideElement / showElement / removeElement: selector\n- setText: selector, text\n- setAttribute: selector, attr, value\n- click / scrollTo: selector\n- fill: selector, value (triggers input event)\n- queryText: selector, returnAs (captures element text into a named result)\n- waitFor: selector, timeout (ms, default 5000)\n- delay: ms\n\nRespond with a brief explanation, then a ```json block containing:\n{ \"type\": \"actions\", \"steps\": [...] }\n\nExample:\n```json\n{ \"type\": \"actions\", \"steps\": [{ \"action\": \"setStyle\", \"selector\": \"h1\", \"style\": { \"color\": \"red\" } }] }\n```";

export { ACTION_SYSTEM_PROMPT, ActionResult, ActionStep, runActions };
