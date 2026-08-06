/**
 * `@theblockbrain/bb-client-sdk/media` — capture-side helpers for dictation.
 *
 * The producing half of the pair whose consuming half (`transcribeAudio`) has
 * been in `./api` since v0.14. Its own subpath rather than a corner of `./api`
 * because a Node consumer of the API layer has no microphone, and a surface that
 * records but posts elsewhere should not pull the API graph.
 */
export {
  audioFilenameFor,
  describeMediaCaptureError,
  extensionForAudioMimeType,
  formatRecordingTime,
  pickAudioMimeType,
  SUPPORTED_AUDIO_MIME_TYPES,
} from "./audio.js";
