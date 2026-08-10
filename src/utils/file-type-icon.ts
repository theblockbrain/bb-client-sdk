/**
 * Which icon a file gets, by extension.
 *
 * One table, so an attachment chip looks the same wherever it is rendered. It
 * arrived here as a second copy: `ms-word-addin` wrote its own with a header
 * saying it mirrors `packages/v1-frontend/constants/constant.tsx`
 * (`mappingFileType`), which is the honest description of a table nobody owns.
 *
 * The two are not the same function, which is why the drift is easy to miss.
 * v1-frontend maps an extension to a **display label** ("Word document"); this
 * maps it to an **artwork basename** ("word"). What they share, and what
 * silently diverges, is the extension vocabulary underneath — which formats are
 * recognised at all, and which ones are grouped together.
 *
 * **The artwork is not here.** This module is a pure `Record<string, string>`
 * with no DOM and no dependency: each surface ships its own icon set and builds
 * its own URL, because the asset pipeline differs per surface (a webpack copy
 * plugin, a Vite public directory, a React Native bundle, a CDN path).
 *
 * ```ts
 * const src = `assets/attach-file/${getFileIconName(file.name, file.type)}.svg`;
 * ```
 */

/**
 * Icon for anything unrecognised. Every surface must ship artwork for it, and it
 * is exported so no caller re-spells the string.
 */
export const FILE_ICON_FALLBACK = "unknown";

/**
 * Extension (lower case, no dot) to icon basename.
 *
 * Exported so a surface can see exactly which artwork it needs to ship: the
 * distinct values of this table, plus {@link FILE_ICON_FALLBACK}. Several
 * extensions deliberately share one icon (`doc`/`docx`/`docm`/`rtf` are all
 * "word"), and a few map to the fallback on purpose (`svg`, `bmp`) because there
 * is no artwork for them.
 */
export const EXTENSION_TO_FILE_ICON: Readonly<Record<string, string>> = {
  // Documents
  pdf: "pdf",
  doc: "word",
  docx: "word",
  docm: "word",
  rtf: "word",
  txt: "txt",
  md: "txt",
  vtt: "vtt",

  // Spreadsheets
  xls: "excel",
  xlsx: "excel",
  csv: "excel",
  // Key and value differ on purpose. Apple Numbers writes `.numbers`, so that is
  // the key; the artwork every surface already ships is `number`, so that is the
  // value. Renaming the asset instead would churn three icon sets to fix a typo
  // that only ever lived in the key.
  numbers: "number",

  // Slides
  ppt: "powerpoint",
  pptx: "powerpoint",

  // Images
  jpg: "jpg",
  jpeg: "jpeg",
  png: "png",
  gif: "gif",
  webp: "webp",
  svg: FILE_ICON_FALLBACK,
  bmp: FILE_ICON_FALLBACK,

  // Email
  eml: "email",
  msg: "email",

  // Audio
  mp3: "mp3",
  m4a: "m4a",
  wav: "wav",
  flac: "flac",
  ogg: "ogg",
  oga: "oga",
  mpga: "mpga",

  // Video
  mp4: "video",
  mov: "video",
  webm: "webm",
  wmv: "video",
  avi: "video",
  mkv: "video",
  flv: "video",

  // Archive
  zip: "zip",
  rar: "zip",
  "7z": "zip",
  tar: "zip",
  gz: "zip",

  // Code / data
  json: "json",
  xml: "xml",
  html: "html",
  htm: "html",
  ifc: "ifc",
  py: "code",
  js: "code",
  jsx: "code",
  ts: "code",
  tsx: "code",
  java: "code",
  cpp: "code",
  c: "code",
  cs: "code",
  go: "code",
  rs: "code",
  swift: "code",
  php: "code",
  rb: "code",
  sql: "code",
  sh: "script",
  bat: "script",
  ps1: "script",
  yaml: "code",
  yml: "code",
};

/** Lower-cased extension of a filename, or `null` when there is none. */
function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Icon basename for a file, falling back to {@link FILE_ICON_FALLBACK}.
 *
 * The filename wins over `fileType` whenever it carries an extension, because
 * the backend's `fileType` is not one thing: it is sometimes an extension and
 * sometimes a MIME type (`application/pdf`) or an internal marker (`URL`,
 * `INSIGHT`). A MIME string is not in the table and resolves to the fallback, so
 * `fileType` is useful here only for the extension-shaped values — it is
 * consulted as a last resort rather than trusted.
 *
 * Status placeholders (a file still uploading, a file that failed) are
 * deliberately outside this function: they are picked by upload state, not by
 * extension, and folding them in would mean this table answering a question it
 * cannot see the input to.
 */
export function getFileIconName(fileName: string, fileType?: string): string {
  const extension = extensionOf(fileName) ?? (fileType ? fileType.toLowerCase() : null);
  if (!extension) return FILE_ICON_FALLBACK;
  return EXTENSION_TO_FILE_ICON[extension] ?? FILE_ICON_FALLBACK;
}
