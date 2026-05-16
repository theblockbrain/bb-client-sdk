import type { ActionStep, ActionResult } from "./schema.js";

/**
 * Execute a list of Action-Library steps against a DOM document.
 * Pure DOM — no eval, no new Function(). CSP-safe on all pages.
 *
 * Self-contained by design: when serialized via chrome.scripting.executeScript({ func }),
 * no external closures or imports are captured. The waitForEl helper is nested inline.
 */
export async function runActions(
  steps: ActionStep[],
  doc: Document = document,
): Promise<ActionResult> {
  async function waitForEl(selector: string, timeout: number): Promise<Element> {
    const el = doc.querySelector(selector);
    if (el) return el;
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const obs = new MutationObserver(() => {
        const found = doc.querySelector(selector);
        if (found) {
          obs.disconnect();
          resolve(found);
        } else if (Date.now() - start > timeout) {
          obs.disconnect();
          reject(new Error(`waitFor: "${selector}" timed out after ${timeout}ms`));
        }
      });
      obs.observe(doc.body, { childList: true, subtree: true });
      setTimeout(() => {
        obs.disconnect();
        reject(new Error(`waitFor: "${selector}" timed out after ${timeout}ms`));
      }, timeout);
    });
  }

  const done: ActionResult["steps"] = [];
  const queryResults: Record<string, unknown> = {};

  for (const step of steps) {
    try {
      switch (step.action) {
        case "setStyle":
          doc.querySelectorAll(step.selector).forEach((el) =>
            Object.assign((el as HTMLElement).style, step.style),
          );
          break;
        case "addClass":
          doc.querySelectorAll(step.selector).forEach((el) =>
            el.classList.add(step.className),
          );
          break;
        case "removeClass":
          doc.querySelectorAll(step.selector).forEach((el) =>
            el.classList.remove(step.className),
          );
          break;
        case "toggleClass":
          doc.querySelectorAll(step.selector).forEach((el) =>
            el.classList.toggle(step.className),
          );
          break;
        case "hideElement":
          doc.querySelectorAll(step.selector).forEach((el) => {
            (el as HTMLElement).style.display = "none";
          });
          break;
        case "showElement":
          doc.querySelectorAll(step.selector).forEach((el) => {
            (el as HTMLElement).style.display = "";
          });
          break;
        case "removeElement":
          doc.querySelectorAll(step.selector).forEach((el) => el.remove());
          break;
        case "setText":
          doc.querySelectorAll(step.selector).forEach((el) => {
            el.textContent = step.text;
          });
          break;
        case "setAttribute":
          doc.querySelectorAll(step.selector).forEach((el) =>
            el.setAttribute(step.attr, step.value),
          );
          break;
        case "click":
          (doc.querySelector(step.selector) as HTMLElement | null)?.click();
          break;
        case "scrollTo":
          doc.querySelector(step.selector)?.scrollIntoView({ behavior: "smooth" });
          break;
        case "fill": {
          const el = doc.querySelector(step.selector) as HTMLInputElement | null;
          if (el) {
            el.value = step.value;
            el.dispatchEvent(new Event("input", { bubbles: true }));
          }
          break;
        }
        case "queryText": {
          const el = doc.querySelector(step.selector);
          if (step.returnAs && el) {
            queryResults[step.returnAs] = (el as HTMLElement).innerText ?? el.textContent ?? "";
          }
          break;
        }
        case "waitFor":
          await waitForEl(step.selector, step.timeout ?? 5000);
          break;
        case "delay":
          await new Promise<void>((r) => setTimeout(r, step.ms));
          break;
        default: {
          // Exhaustiveness guard — TypeScript will error if a new ActionStep variant is added
          // without handling it here.
          const _never: never = step;
          done.push({ action: (_never as ActionStep).action, ok: false, error: "Unknown action" });
          continue;
        }
      }
      done.push({
        action: step.action,
        selector: "selector" in step ? step.selector : undefined,
        ok: true,
      });
    } catch (err) {
      done.push({
        action: step.action,
        selector: "selector" in step ? step.selector : undefined,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { success: true, steps: done, queryResults };
}
