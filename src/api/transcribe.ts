import type { AuthContext } from "../settings/auth-mode.js";
import { requestJson } from "./_send.js";
import { authHeaders } from "./headers.js";

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
  const form = new FormData();
  form.append("file", audio, filename);
  form.append("model", model);

  // Build headers without Accept — browser manages Content-Type for multipart
  const headers = authHeaders(ctx.token, ctx.orgId);
  delete headers.Accept;

  const data = await requestJson<TranscribeResponse>(ctx, {
    host: "blocky",
    path: endpoint,
    method: "POST",
    headers,
    body: form,
  });
  const text = data?.body?.text ?? data?.body?.content ?? data?.text ?? "";
  if (!text) throw new Error("Empty transcription returned.");
  return text.trim();
}
