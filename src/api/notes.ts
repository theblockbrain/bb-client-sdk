import type { AuthContext } from "../settings/auth-mode.js";
import { request, throwIfNotOk } from "./_send.js";
import { BBApiError } from "./errors.js";
import { authHeaders } from "./headers.js";

export interface CreateNoteParams {
  title: string;
  summary: string;
  parentPath?: string;
  isAiGenerated?: boolean;
}

/**
 * Result shape mirrors `NoteShortDTO` (extends `BaseDTO`) from
 * blocky/src/api/nexus/notes/schemas.py.
 * The route returns a ResponseEntity envelope: { code, key, body: NoteShortDTO }.
 */
export interface NoteResult {
  _id: string;
  title: string;
  isEdited: boolean;
  createdAt: string;
  modifiedAt: string;
}

interface NoteCreateEnvelope {
  code: number;
  key: string | null;
  body: NoteResult;
}

/**
 * Save a note (insight) to the authenticated user's Blockbrain workspace.
 *
 * POST /cortex/notes/add-note
 * Backend: blocky/src/api/nexus/notes/routes.py — `add_chat_note_manual`
 * Body schema: NoteCreateDTO (title, summary, parent_path?, is_ai_generated?)
 *
 * Field names are snake_case as required by the backend model
 * (`BlockyBaseModel` populates by field name, not alias, for POST bodies).
 */
export async function createNote(ctx: AuthContext, params: CreateNoteParams): Promise<NoteResult> {
  const res = await request(ctx, {
    host: "blocky",
    path: "/cortex/notes/add-note",
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(ctx.token, ctx.orgId) },
    body: JSON.stringify({
      title: params.title,
      summary: params.summary,
      parent_path: params.parentPath,
      is_ai_generated: params.isAiGenerated ?? false,
    }),
  });

  await throwIfNotOk(res, "/cortex/notes/add-note");

  const envelope = await res.json<NoteCreateEnvelope>();
  const data = envelope.body;
  if (!data?._id) {
    throw new BBApiError("Note create response missing _id", res.status, {
      endpoint: "/cortex/notes/add-note",
      responseBody: envelope,
    });
  }
  return data;
}
