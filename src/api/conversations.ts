import { authHeaders } from "./headers.js";
import { normalizeUrl } from "./url.js";
import { BBApiError } from "./errors.js";
import type { AuthContext } from "../settings/auth-mode.js";

interface ConversationResponse {
  body: { dataRoomId: string };
}

/** Create a new conversation for a bot. Returns the conversation ID. */
export async function createConversation(
  ctx: AuthContext,
  botId: string,
  convoName = "BlockBrain Conversation",
): Promise<{ convoId: string }> {
  const endpoint = `/cortex/active-bot/${botId}/convo`;
  const url = normalizeUrl(ctx.baseUrl);
  const res = await fetch(`${url}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(ctx.token, ctx.orgId),
    },
    body: JSON.stringify({ convoName }),
  });

  if (!res.ok) {
    let body: unknown;
    try { body = await res.json(); } catch { /* response may not be JSON */ }
    throw new BBApiError(`API ${res.status} at ${endpoint}`, res.status, { endpoint, responseBody: body });
  }

  const data = (await res.json()) as ConversationResponse;
  return { convoId: data.body.dataRoomId };
}
