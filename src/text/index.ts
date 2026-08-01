/**
 * Text parsing helpers for LLM output — `./text`.
 *
 * Split out of `./utils` (PDEV-7684). "Utils" is a name that means nothing and
 * therefore attracts everything: it had accumulated JSON repair, code-fence
 * stripping, a JWT decoder and an async lock, which share no concern beyond
 * having had nowhere else to go. The JWT decoder moved to `./auth` (where its
 * one caller lives, and where it merged with the duplicate that had drifted from
 * it); `createLock` stayed behind in `./utils`.
 *
 * What belongs here: parsing text a model produced. Nothing in this module
 * touches the network, the DOM, or auth.
 */
export { extractCode } from "./code-fence.js";
export { extractJson, repairUnescapedQuotes } from "./extract-json.js";
