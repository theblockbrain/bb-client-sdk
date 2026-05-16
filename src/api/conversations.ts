import { authHeaders } from "./headers.js";
import { normalizeUrl } from "./url.js";
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
  const url = normalizeUrl(ctx.baseUrl);
  const res = await fetch(`${url}/cortex/active-bot/${botId}/convo`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(ctx.token, ctx.orgId),
    },
    body: JSON.stringify({ convoName }),
  });

  if (!res.ok) throw new Error(`API ${res.status}`);

  const data = (await res.json()) as ConversationResponse;
  return { convoId: data.body.dataRoomId };
}
