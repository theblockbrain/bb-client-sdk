/**
 * Robustly extract a JSON value from an LLM response.
 *
 * Handles markdown code fences, prose wrapped around the JSON, unescaped
 * quotes inside string values, and a response the model stopped emitting
 * mid-stream. Returns the parsed value, or null when nothing could be
 * recovered. Does NOT throw: callers handle null explicitly.
 *
 * The repair passes are ported from the Word add-in's edit-instruction parser
 * (`packages/word-addin/src/lib/text/edit-instructions.ts`), which had been
 * hardened against two measured incidents this module knew nothing about. See
 * `repairUnescapedQuotes` (PDEV-7477, a German translation whose ~90 correct
 * edits were all discarded) and `closeUnbalancedJson` (a response that arrived
 * 95% finished and produced zero results).
 *
 * ORDER OF THE FALLBACK CHAIN, and why it is this order:
 *
 *   1. parse the fence-stripped text as-is
 *   2. parse the first structural block, which drops prose around the JSON
 *   3. parse it again after escaping stray quotes inside string values
 *   4. parse it again after closing the brackets a cut-off stream left open
 *   5. parse it after BOTH repairs, since a response can carry both defects
 *
 * Steps 1 and 2 come first because a response that already parses must never
 * be rewritten. Step 3 sits ahead of step 4 as a tie-break on which kind of
 * loss to prefer: both passes are lossy, but in opposite directions. Quote
 * repair returns the WHOLE response with string content rewritten, while
 * bracket closing returns a PREFIX of it, dropping every element after the
 * cut. Silently dropping elements is the worse outcome (a translation that
 * renders 40 of 60 segments reads as "finished"), so the pass that can still
 * return everything is tried first. The add-in orders these two the other way
 * round, on the grounds that structure-only repair should precede content
 * rewriting. No input is known where the two orders disagree, since quote
 * repair cannot balance brackets and closing cannot alter content, so treat
 * this as a documented judgement call rather than a correctness claim.
 *
 * CALLERS THAT SHOW THE RESULT TO A USER: a step 4 or 5 recovery is a partial
 * value by construction, and this signature cannot say so. Until a
 * meta-returning variant exists, either treat a short result as suspect or run
 * the passes yourself. `repairUnescapedQuotes` and `closeUnbalancedJson` are
 * exported for exactly that: a consumer validating against a schema has to
 * re-validate after each pass anyway, which this function cannot do for it.
 */
export function extractJson<T = unknown>(text: string): T | null {
  // Strip markdown code fences
  const cleaned = text
    .replace(/```(?:json|javascript|js|ts|typescript)?([\s\S]*?)```/g, "$1")
    .trim();

  const direct = tryParse<T>(cleaned);
  if (direct !== null) return direct;

  // Candidate 1: first {...} or [...] block. Unchanged from the original
  // implementation, and tried first so that every input this module already
  // recovered keeps recovering to the identical value. The repair passes below
  // can only turn a former null into a value, never change an existing one.
  const match = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  const block = match ? match[0] : null;
  const fromBlock = block === null ? null : recoverFrom<T>(block);
  if (fromBlock !== null) return fromBlock;

  // Candidate 2: a slice anchored on the last STRUCTURAL closer. See
  // `truncationSlice` for the two shapes candidate 1 cannot express.
  const sliced = truncationSlice(cleaned);
  if (sliced === null || sliced === block) return null;
  return recoverFrom<T>(sliced);
}

function tryParse<T>(str: string): T | null {
  try {
    return JSON.parse(str) as T;
  } catch {
    return null;
  }
}

/** Steps 2 to 5 of the chain above, applied to one candidate fragment. */
function recoverFrom<T>(candidate: string): T | null {
  const asIs = tryParse<T>(candidate);
  if (asIs !== null) return asIs;

  const requoted = repairUnescapedQuotes(candidate);
  const changedQuotes = requoted !== candidate;
  if (changedQuotes) {
    const fromQuotes = tryParse<T>(requoted);
    if (fromQuotes !== null) return fromQuotes;
  }

  const closed = closeUnbalancedJson(candidate);
  if (closed !== null) {
    const fromClosing = tryParse<T>(closed);
    if (fromClosing !== null) return fromClosing;
  }

  // Stray quotes AND a truncated stream. Neither pass alone can fix this: the
  // stray quote leaves the fragment ending "inside a string" as far as the
  // bracket walker can tell, so it refuses, and the missing brackets keep the
  // requoted text from parsing.
  if (changedQuotes) {
    const closedRequoted = closeUnbalancedJson(requoted);
    if (closedRequoted !== null) return tryParse<T>(closedRequoted);
  }

  return null;
}

/**
 * Index of the last `}` or `]` at or after `from` that is real JSON structure,
 * i.e. NOT inside a string value. Returns -1 when there is none.
 *
 * A plain `lastIndexOf` cannot tell the two apart, and the difference decides
 * whether a truncated response is recoverable. Model output routinely carries
 * brackets inside prose (`Fussnote [1] siehe`, `Vorlage {x}`), and when the
 * stream is cut mid-element the last bracket in the text is easily one of
 * those. Ending the fragment there puts it INSIDE an unterminated string,
 * `closeUnbalancedJson` then correctly refuses to repair it, and every
 * complete element that did arrive is discarded. The add-in measured this: an
 * otherwise-recoverable response went from 1 edit to 0 purely because the
 * partial trailing edit mentioned `[1]`.
 *
 * Scanning starts at `from` rather than 0 so that a quote in the prose ahead of
 * the JSON cannot invert string parity for the whole walk.
 */
function lastStructuralCloserIndex(text: string, from: number): number {
  let inString = false;
  let escapeNext = false;
  let lastCloser = -1;

  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (inString && ch === "\\") {
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString && (ch === "}" || ch === "]")) {
      lastCloser = i;
    }
  }

  return lastCloser;
}

/**
 * The fragment from the first opener to the last STRUCTURAL closer, or null
 * when there is no such pair.
 *
 * This is the second candidate because the first-block regex cannot express
 * two shapes that a cut-off stream produces:
 *
 *   - A bare array whose `]` never arrived. `[{…},{…},{"ori` has no `[…]` pair,
 *     so the regex falls through to the first `{` and yields comma-separated
 *     objects (`{…},{…}`) that no amount of bracket-closing can repair. This
 *     slice anchors on the `[` instead, so the closers can be appended.
 *   - A response whose last `}` or `]` sits inside a string. The regex uses
 *     "up to the last bracket character" and lands mid-string, which is
 *     unrepairable by design. This slice lands on the last real closer, which
 *     is where the complete elements end.
 *
 * Deliberately NOT extended to "everything up to the end of input": appending
 * closers to a fragment ending in a half-written key or value (`…,"posit`)
 * cannot parse, and where it could (`{"a":[1,2` becoming `{"a":[1,2]}`) it
 * would invent a complete-looking value out of a truncated one. Recovering
 * whole elements is defensible, guessing at a partial one is not.
 */
function truncationSlice(text: string): string | null {
  const firstBrace = text.indexOf("{");
  const firstBracket = text.indexOf("[");
  const start =
    firstBrace === -1
      ? firstBracket
      : firstBracket === -1
        ? firstBrace
        : Math.min(firstBrace, firstBracket);
  if (start === -1) return null;

  const end = lastStructuralCloserIndex(text, start);
  if (end <= start) return null;
  return text.slice(start, end + 1);
}

/** First index at or after `from` that is not whitespace. */
function skipWhitespace(text: string, from: number): number {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

function charAtOrNull(text: string, index: number): string | null {
  return index < text.length ? text[index] : null;
}

/**
 * Does a JSON value begin at `index`?
 *
 * Keywords are matched in FULL, never by first letter: accepting a bare
 * `t`/`f`/`n` classifies German prose as structure. `„node", nein` reads `nein`
 * as the start of `null`, and the caller then loses string parity for the rest
 * of the document.
 */
function startsJsonValueAt(text: string, index: number): boolean {
  const ch = charAtOrNull(text, index);
  if (ch === null) return false;
  if (ch === '"' || ch === "{" || ch === "[" || ch === "-") return true;
  if (ch >= "0" && ch <= "9") return true;
  return (
    text.startsWith("true", index) ||
    text.startsWith("false", index) ||
    text.startsWith("null", index)
  );
}

/**
 * Does the unescaped `"` at `quoteIndex` close its string, or is it content?
 *
 * Two tokens of lookahead, because one is not enough. This module used to look
 * at one: skip whitespace, and treat `,` `}` `]` `:` as proof of a terminator.
 * A stray quote in prose is ALSO followed by a structural character, so that
 * test misfires. The measured case is a German translation containing
 * `…moduleResolution: „node", was die Map ignoriert`: the comma sits directly
 * after a quote that belongs to the text, the pass closed the string there,
 * and parity was wrong for everything after it.
 *
 * So the character AFTER that token decides: a real `:` or `,` must be
 * followed by the START of a JSON value, and a real `}` or `]` only by `,` `}`
 * `]` or end of input. `", was` fails both, since `w` begins no JSON value.
 */
function quoteClosesString(text: string, quoteIndex: number): boolean {
  const nextIndex = skipWhitespace(text, quoteIndex + 1);
  const next = charAtOrNull(text, nextIndex);
  if (next === null) return true;

  if (next === ":" || next === ",") {
    const afterIndex = skipWhitespace(text, nextIndex + 1);
    return afterIndex >= text.length || startsJsonValueAt(text, afterIndex);
  }
  if (next === "}" || next === "]") {
    const after = charAtOrNull(text, skipWhitespace(text, nextIndex + 1));
    return after === null || after === "," || after === "}" || after === "]";
  }
  return false;
}

/**
 * Best-effort repair of unescaped quote characters within JSON string values.
 *
 * Real failure (PDEV-7477): a whole-document translation to German came back
 * as ~90 correct edits, and every one was thrown away, because the model writes
 * German quotation marks as an opening `„` (U+201E) followed by a CLOSING
 * ASCII `"`:
 *
 *     "modified":"…(die „3 fehlenden Commits").\n"
 *                                          ↑ ends the JSON string here
 *
 * `JSON.parse` then reads `).` as structure and fails, and the user was shown
 * a raw JSON wall of text instead of suggestions.
 *
 * Walks character-by-character tracking string context, and escapes any quote
 * that `quoteClosesString` (which documents the two-token lookahead rule this
 * pass depends on) does not accept as a terminator. Backslash escapes are
 * honoured, so an already-escaped quote is never double-escaped.
 *
 * Still a heuristic. A stray quote followed by `, "` (comma then a genuine
 * quote) reads as a terminator and loses. Two concatenated objects
 * (`{"a":"b"}{"c":"d"}`) now get their terminator escaped where the old
 * one-token rule left it alone, which changes this function's output for that
 * input but not `extractJson`'s: neither form parses, so both end at null.
 * The pass runs last, so a response that already parses is never touched.
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

    if (char !== '"') {
      result += char;
      continue;
    }

    if (!inString) {
      inString = true;
      result += char;
      continue;
    }

    if (quoteClosesString(str, i)) {
      inString = false;
      result += char;
      continue;
    }

    // Quote inside a string value: escape it
    result += '\\"';
  }

  return result;
}

/**
 * Close an unbalanced JSON fragment left behind by a response the model never
 * finished emitting. Returns the closed text, or null when there is nothing to
 * close or the fragment cannot be closed correctly.
 *
 * Running out of output tokens mid-answer is a routine outcome, and it stops
 * the stream in the middle of an element:
 * `…,{"original":"Anbauteile","modified":"Attachment part","posit`. Cutting at
 * the last structural closer leaves a well-formed prefix that is merely missing
 * its closing brackets:
 *
 *     {"edits":[{…},{…},{…}          ← needs "]}"
 *
 * The add-in measured what happens without this pass: a translation that
 * arrived 95% finished produced zero suggestions, because every complete
 * element was thrown away along with the incomplete one.
 *
 * Walks the fragment tracking string and escape state, so brackets inside
 * translated text are not mistaken for structure, then appends the outstanding
 * closers in reverse order. Returns null when the brackets are already balanced
 * (nothing to repair) and, deliberately, when the fragment ends INSIDE an
 * unterminated string: the missing tail is content, and closing the quote would
 * fabricate a value rather than recover one.
 *
 * Exported because a consumer validating against a schema cannot use
 * `extractJson` alone (it returns the first thing that parses, which for a
 * truncated array can be the wrong shape) and has to re-validate after each
 * pass itself. A non-null return is also the only available signal that a
 * response was cut off, which is what a UI needs in order to say "partial"
 * instead of quietly showing less than arrived.
 */
export function closeUnbalancedJson(json: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escapeNext = false;

  for (const ch of json) {
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === "\\") {
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }

  if (inString || stack.length === 0) return null;

  const closers = stack
    .reverse()
    .map(open => (open === "{" ? "}" : "]"))
    .join("");
  return `${json}${closers}`;
}
