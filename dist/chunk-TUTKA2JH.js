// src/actions/schema.ts
var AVAILABLE_ACTIONS = [
  "setStyle",
  "addClass",
  "removeClass",
  "toggleClass",
  "hideElement",
  "showElement",
  "removeElement",
  "setText",
  "setAttribute",
  "click",
  "scrollTo",
  "fill",
  "queryText",
  "waitFor",
  "delay"
];

// src/actions/runner.ts
async function runActions(steps, doc = document) {
  async function waitForEl(selector, timeout) {
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
  const done = [];
  const queryResults = {};
  for (const step of steps) {
    try {
      switch (step.action) {
        case "setStyle":
          doc.querySelectorAll(step.selector).forEach(
            (el) => Object.assign(el.style, step.style)
          );
          break;
        case "addClass":
          doc.querySelectorAll(step.selector).forEach(
            (el) => el.classList.add(step.className)
          );
          break;
        case "removeClass":
          doc.querySelectorAll(step.selector).forEach(
            (el) => el.classList.remove(step.className)
          );
          break;
        case "toggleClass":
          doc.querySelectorAll(step.selector).forEach(
            (el) => el.classList.toggle(step.className)
          );
          break;
        case "hideElement":
          doc.querySelectorAll(step.selector).forEach((el) => {
            el.style.display = "none";
          });
          break;
        case "showElement":
          doc.querySelectorAll(step.selector).forEach((el) => {
            el.style.display = "";
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
          doc.querySelectorAll(step.selector).forEach(
            (el) => el.setAttribute(step.attr, step.value)
          );
          break;
        case "click":
          doc.querySelector(step.selector)?.click();
          break;
        case "scrollTo":
          doc.querySelector(step.selector)?.scrollIntoView({ behavior: "smooth" });
          break;
        case "fill": {
          const el = doc.querySelector(step.selector);
          if (el) {
            el.value = step.value;
            el.dispatchEvent(new Event("input", { bubbles: true }));
          }
          break;
        }
        case "queryText": {
          const el = doc.querySelector(step.selector);
          if (step.returnAs && el) {
            queryResults[step.returnAs] = el.innerText ?? el.textContent ?? "";
          }
          break;
        }
        case "waitFor":
          await waitForEl(step.selector, step.timeout ?? 5e3);
          break;
        case "delay":
          await new Promise((r) => setTimeout(r, step.ms));
          break;
        default: {
          const _never = step;
          done.push({ action: _never.action, ok: false, error: "Unknown action" });
          continue;
        }
      }
      done.push({
        action: step.action,
        selector: "selector" in step ? step.selector : void 0,
        ok: true
      });
    } catch (err) {
      done.push({
        action: step.action,
        selector: "selector" in step ? step.selector : void 0,
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  return { success: true, steps: done, queryResults };
}

export {
  AVAILABLE_ACTIONS,
  runActions
};
//# sourceMappingURL=chunk-TUTKA2JH.js.map