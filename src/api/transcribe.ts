import type { AuthContext } from "../settings/auth-mode.js";
import { BBApiError } from "./errors.js";
import { authHeaders } from "./headers.js";
import { normalizeUrl } from "./url.js";

interface TranscribeResponse {
  body?: { text?: string; content?: string };
  text?: string;
}

/**
 * Transcribe an audio blob via the BlockBrain sp2text endpoint.
 *
 * The browser sets the multipart/form-data Content-Type header with boundary automatically —
 * do NOT override it. x-zitadel-org-id is handled via authHeaders(ctx).
 */
export async function transcribeAudio(
  ctx: AuthContext,
  audio: Blob,
  filename = "recording.webm",
  model = "azure-whisper",
): Promise<string> {
  const endpoint = "/sp2text/generate";
  const url = normalizeUrl(ctx.baseUrl);
  const form = new FormData();
  form.append("file", audio, filename);
  form.append("model", model);

  // Build headers without Accept — browser manages Content-Type for multipart
  const headers = authHeaders(ctx.token, ctx.orgId);
  delete headers.Accept;

  const res = await fetch(`${url}${endpoint}`, {
    method: "POST",
    headers,
    body: form,
  });

  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      /* response may not be JSON */
    }
    throw new BBApiError(`API ${res.status} at ${endpoint}`, res.status, {
      endpoint,
      responseBody: body,
    });
  }

  const data = (await res.json()) as TranscribeResponse;
  const text = data?.body?.text ?? data?.body?.content ?? data?.text ?? "";
  if (!text) throw new Error("Empty transcription returned.");
  return text.trim();
}
