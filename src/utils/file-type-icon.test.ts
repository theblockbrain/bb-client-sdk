import { describe, expect, it } from "vitest";
import { EXTENSION_TO_FILE_ICON, FILE_ICON_FALLBACK, getFileIconName } from "./file-type-icon.js";

describe("getFileIconName", () => {
  it("maps a known extension to its icon", () => {
    expect(getFileIconName("report.pdf")).toBe("pdf");
    expect(getFileIconName("minutes.docx")).toBe("word");
    expect(getFileIconName("budget.xlsx")).toBe("excel");
  });

  it("is case-insensitive, because a filename's case is the user's business", () => {
    expect(getFileIconName("REPORT.PDF")).toBe("pdf");
    expect(getFileIconName("Minutes.DocX")).toBe("word");
  });

  // A filename is not a path segment with exactly one dot.
  it("reads the last extension, not the first", () => {
    expect(getFileIconName("archive.tar.gz")).toBe("zip");
    expect(getFileIconName("my.report.final.pdf")).toBe("pdf");
  });

  it("falls back for anything it does not recognise", () => {
    expect(getFileIconName("mystery.qqq")).toBe(FILE_ICON_FALLBACK);
    // No extension at all, and a trailing dot that leaves an empty one.
    expect(getFileIconName("README")).toBe(FILE_ICON_FALLBACK);
    expect(getFileIconName("trailing.")).toBe(FILE_ICON_FALLBACK);
    expect(getFileIconName("")).toBe(FILE_ICON_FALLBACK);
    // A dotfile has no name, so the whole thing reads as the extension. It
    // misses the table and lands on the fallback, which is the right icon.
    expect(getFileIconName(".gitignore")).toBe(FILE_ICON_FALLBACK);
  });

  // The backend's `fileType` is not one thing: sometimes an extension, sometimes
  // a MIME type, sometimes an internal marker. The filename is the reliable
  // signal, so it wins whenever it has one.
  it("prefers the filename's extension over fileType", () => {
    expect(getFileIconName("report.pdf", "application/msword")).toBe("pdf");
    expect(getFileIconName("report.pdf", "INSIGHT")).toBe("pdf");
  });

  it("consults fileType only when the name carries no extension", () => {
    expect(getFileIconName("attachment", "png")).toBe("png");
    expect(getFileIconName("attachment", "PNG")).toBe("png");
    // A MIME type is not in the table, and is not taken apart to find one.
    expect(getFileIconName("attachment", "application/pdf")).toBe(FILE_ICON_FALLBACK);
  });

  // Grouping is the point of the table, and a regrouping is a visible change.
  it("groups the formats that share one icon", () => {
    for (const name of ["a.doc", "a.docx", "a.docm", "a.rtf"]) {
      expect(getFileIconName(name)).toBe("word");
    }
    for (const name of ["a.zip", "a.rar", "a.7z", "a.tar", "a.gz"]) {
      expect(getFileIconName(name)).toBe("zip");
    }
    // csv is a spreadsheet here, not a text file.
    expect(getFileIconName("rows.csv")).toBe("excel");
  });

  // Deliberate: there is no artwork for these, and mapping them to the fallback
  // is different from forgetting them.
  it("maps the formats with no artwork to the fallback on purpose", () => {
    expect(getFileIconName("logo.svg")).toBe(FILE_ICON_FALLBACK);
    expect(getFileIconName("scan.bmp")).toBe(FILE_ICON_FALLBACK);
  });

  // Apple Numbers writes `.numbers`. The table was keyed on `number`, which is
  // not an extension anything produces, so the `number` artwork was unreachable
  // and every real Numbers file fell through to the fallback.
  it("recognises an Apple Numbers file by the extension it actually has", () => {
    expect(getFileIconName("q3.numbers")).toBe("number");
  });
});

describe("EXTENSION_TO_FILE_ICON", () => {
  // A surface ships one asset per distinct value, so a key whose value looks
  // like an extension rather than an icon name is a missing file at runtime.
  it("keys are bare lower-case extensions with no leading dot", () => {
    for (const key of Object.keys(EXTENSION_TO_FILE_ICON)) {
      expect(key).toBe(key.toLowerCase());
      expect(key.startsWith(".")).toBe(false);
    }
  });

  // The values name artwork basenames, so a slash or an extension in one would
  // build a broken URL at every call site.
  it("values are bare basenames, with no path or extension", () => {
    for (const value of Object.values(EXTENSION_TO_FILE_ICON)) {
      expect(value).toMatch(/^[a-z0-9-]+$/);
    }
  });
});
