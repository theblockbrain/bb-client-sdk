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

export { ActionResult, ActionStep, runActions };
