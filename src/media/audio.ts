/**
 * Audio capture helpers — the framework-free half of dictation.
 *
 * `transcribeAudio` has shipped in `./api` since v0.14 and takes a `Blob`,
 * deliberately unopinionated about how the browser produced it. That left every
 * surface to work out *producing* it alone, and three of them did:
 * `ms-outlook-addin` twice (task pane and dictation popup, byte-identical), and
 * `ms-word-addin` once inside a 323-line `useAudioRecorder`. All three pick a
 * MediaRecorder mime type from the same candidate list, derive the same upload
 * filename extension, and map the same three `DOMException` names.
 *
 * **No DOM types here.** `MediaRecorder`, `MediaStream` and `DOMException` live
 * only in TypeScript's `dom` lib, and naming one in a public signature breaks a
 * consumer whose `lib` excludes it — React Native is a first-class target
 * (invariant B). Support is passed in as a predicate and errors are inspected
 * structurally, so this module compiles under bare Node and is unit-testable
 * without a browser.
 *
 * What is deliberately NOT here: the recorder state machine. Outlook drives a
 * five-state task-pane button with an external `stopAndTranscribe` handle; Word
 * drives a volume analyser. Those are UI, they disagree, and neither is more
 * right — so the SDK supplies the decisions both make identically and stays out
 * of the part they don't.
 */

import type { BBMessageKey } from "../i18n/keys.js";

/**
 * Candidate container/codec pairs, best first.
 *
 * Opus in WebM leads because it is what the sp2text backend transcribes best at
 * the smallest size. `audio/mp4` is last and exists for Safari/iOS, which
 * supports none of the others.
 */
const AUDIO_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
] as const;

/** The candidate list, for a surface that wants to show or log what it tried. */
export const SUPPORTED_AUDIO_MIME_TYPES: readonly string[] = AUDIO_MIME_CANDIDATES;

/**
 * The first candidate this environment can record, or `undefined` to let the
 * recorder choose.
 *
 * `isTypeSupported` is a parameter rather than a global read: `MediaRecorder` is
 * a DOM global, and dereferencing it at module scope is what makes a module
 * unimportable under Node. Browser callers pass
 * `MediaRecorder.isTypeSupported.bind(MediaRecorder)` — the bind matters, the
 * method is not a free function.
 *
 * `undefined` (rather than a hardcoded default) is the honest answer when nothing
 * matches: `new MediaRecorder(stream)` with no options lets the browser pick a
 * format it definitely supports, whereas forcing one it rejected throws.
 */
export function pickAudioMimeType(isTypeSupported?: (type: string) => boolean): string | undefined {
  if (typeof isTypeSupported !== "function") return undefined;
  for (const candidate of AUDIO_MIME_CANDIDATES) {
    try {
      if (isTypeSupported(candidate)) return candidate;
    } catch {
      // A host predicate that throws is treated as "not supported" rather than
      // being allowed to abort the whole selection.
    }
  }
  return undefined;
}

/**
 * Upload filename extension for a recorded mime type.
 *
 * The backend infers the container from the filename, so this has to agree with
 * whatever the recorder actually produced — pass `recorder.mimeType` (what was
 * used), not the type you requested (what you asked for). They differ: a browser
 * may honour the container and substitute the codec.
 */
export function extensionForAudioMimeType(mimeType: string): string {
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("ogg")) return "ogg";
  return "webm";
}

/** Conventional upload filename for a recording. */
export function audioFilenameFor(mimeType: string, stem = "recording"): string {
  return `${stem}.${extensionForAudioMimeType(mimeType)}`;
}

/**
 * Elapsed recording time as `mm:ss`.
 *
 * Locale-independent by design, so it does not go through the L12 formatter port:
 * a recording timer is a stopwatch, and every locale renders one the same way.
 * Minutes are not clamped to two digits — a 100-minute recording reads `100:00`
 * rather than wrapping to `40:00`.
 */
export function formatRecordingTime(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

/**
 * Why microphone capture failed, as an L12 key.
 *
 * A key rather than a sentence, for the same reason `describeBBApiError` returns
 * one: the SDK owns the vocabulary, each surface owns the wording. Returning
 * English here would have every add-in either render it raw or re-map it.
 *
 * Reads `name` structurally instead of `instanceof DOMException` — the class is
 * DOM-only, and `getUserMedia` rejections cross realms in an Office add-in
 * (task pane iframe vs. dialog window), where `instanceof` is unreliable anyway.
 */
export function describeMediaCaptureError(err: unknown): BBMessageKey {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "media.permissionDenied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "media.deviceNotFound";
  return "media.captureFailed";
}
