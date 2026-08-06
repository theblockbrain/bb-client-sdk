import { describe, expect, it } from "vitest";
import {
  audioFilenameFor,
  describeMediaCaptureError,
  extensionForAudioMimeType,
  formatRecordingTime,
  pickAudioMimeType,
  SUPPORTED_AUDIO_MIME_TYPES,
} from "./audio.js";

describe("pickAudioMimeType", () => {
  it("returns undefined when the host supplies no predicate", () => {
    // Not a hardcoded default: `new MediaRecorder(stream)` with no options lets
    // the browser pick something it definitely supports.
    expect(pickAudioMimeType()).toBeUndefined();
  });

  it("prefers opus-in-webm when everything is supported", () => {
    expect(pickAudioMimeType(() => true)).toBe("audio/webm;codecs=opus");
  });

  it("falls back to audio/mp4 for a Safari-shaped host", () => {
    expect(pickAudioMimeType(type => type === "audio/mp4")).toBe("audio/mp4");
  });

  it("returns undefined when nothing in the list is supported", () => {
    expect(pickAudioMimeType(() => false)).toBeUndefined();
  });

  it("treats a throwing predicate as unsupported rather than aborting", () => {
    const supported = (type: string): boolean => {
      if (type.includes("webm")) throw new TypeError("bad argument");
      return type === "audio/ogg;codecs=opus";
    };
    expect(pickAudioMimeType(supported)).toBe("audio/ogg;codecs=opus");
  });

  it("only ever offers candidates from the published list", () => {
    const seen: string[] = [];
    pickAudioMimeType(type => {
      seen.push(type);
      return false;
    });
    expect(seen).toEqual([...SUPPORTED_AUDIO_MIME_TYPES]);
  });
});

describe("extensionForAudioMimeType", () => {
  it.each([
    ["audio/webm;codecs=opus", "webm"],
    ["audio/webm", "webm"],
    ["audio/ogg;codecs=opus", "ogg"],
    ["audio/mp4", "m4a"],
    // The backend infers the container from the filename, so an unknown type
    // must still yield something it can open rather than an empty extension.
    ["audio/unknown-format", "webm"],
    ["", "webm"],
  ])("maps %s to .%s", (mimeType, extension) => {
    expect(extensionForAudioMimeType(mimeType)).toBe(extension);
  });
});

describe("audioFilenameFor", () => {
  it("uses the conventional stem by default", () => {
    expect(audioFilenameFor("audio/webm;codecs=opus")).toBe("recording.webm");
  });

  it("honours a caller-supplied stem", () => {
    expect(audioFilenameFor("audio/mp4", "dictation")).toBe("dictation.m4a");
  });
});

describe("formatRecordingTime", () => {
  it.each([
    [0, "00:00"],
    [999, "00:00"],
    [1_000, "00:01"],
    [59_000, "00:59"],
    [60_000, "01:00"],
    [3_599_000, "59:59"],
  ])("renders %ims as %s", (elapsedMs, expected) => {
    expect(formatRecordingTime(elapsedMs)).toBe(expected);
  });

  it("does not wrap past an hour", () => {
    // Minutes are deliberately unclamped — a 100-minute recording reads 100:00,
    // not 40:00.
    expect(formatRecordingTime(6_000_000)).toBe("100:00");
  });

  it("clamps a negative elapsed time to zero", () => {
    // A clock adjustment mid-recording can make `now - start` negative.
    expect(formatRecordingTime(-5_000)).toBe("00:00");
  });
});

describe("describeMediaCaptureError", () => {
  it.each([
    ["NotAllowedError", "media.permissionDenied"],
    ["SecurityError", "media.permissionDenied"],
    ["NotFoundError", "media.deviceNotFound"],
    ["OverconstrainedError", "media.deviceNotFound"],
    ["NotReadableError", "media.captureFailed"],
    ["AbortError", "media.captureFailed"],
  ])("maps a %s rejection to %s", (name, key) => {
    expect(describeMediaCaptureError({ name })).toBe(key);
  });

  it("reads `name` structurally, so a cross-realm rejection still maps", () => {
    // getUserMedia rejections cross realms in an Office add-in (task pane iframe
    // vs. dialog window), where `instanceof DOMException` is unreliable.
    const crossRealm = Object.create(null) as { name: string };
    crossRealm.name = "NotAllowedError";
    expect(describeMediaCaptureError(crossRealm)).toBe("media.permissionDenied");
  });

  it.each([[null], [undefined], ["NotAllowedError"], [42], [{}]])(
    "falls back to media.captureFailed for %s",
    value => {
      expect(describeMediaCaptureError(value)).toBe("media.captureFailed");
    },
  );
});
