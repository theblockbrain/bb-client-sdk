/**
 * Ad-hoc fixture: verify that createMessageStream does NOT emit an unhandledRejection
 * when the source throws and the caller only iterates textDeltas (never touches `final`).
 *
 * Run: bun run scripts/verify-unhandled-rejection.mjs
 *      node --input-type=module < scripts/verify-unhandled-rejection.mjs
 */

import { createMessageStream } from "../dist/api/index.js";

const unhandled = [];
process.on("unhandledRejection", (reason) => {
  unhandled.push(reason);
});

async function* throwingSource() {
  yield "hello ";
  yield "world";
  throw new Error("simulated SSE error mid-stream");
}

const stream = createMessageStream(throwingSource());

// Caller only iterates textDeltas — does NOT touch `final`
const collected = [];
try {
  for await (const delta of stream.textDeltas) {
    collected.push(delta);
  }
  console.error("FAIL: expected textDeltas to throw, but it completed normally");
  process.exit(1);
} catch (err) {
  // Expected: error propagates through textDeltas correctly
  if (err.message !== "simulated SSE error mid-stream") {
    console.error("FAIL: unexpected error:", err);
    process.exit(1);
  }
}

// Give microtasks + one event-loop tick for any unhandledRejection to fire
await new Promise((r) => setTimeout(r, 50));

if (unhandled.length > 0) {
  console.error("FAIL: unhandledRejection fired:", unhandled);
  process.exit(1);
}

console.log("PASS: collected deltas =", collected);
console.log("PASS: no unhandledRejection emitted");
console.log("PASS: collected text =", collected.join(""));
