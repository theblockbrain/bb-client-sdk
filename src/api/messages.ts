import { authHeaders } from "./headers.js";
import { normalizeUrl } from "./url.js";
import type { AuthContext } from "../settings/auth-mode.js";

interface MessageResponse {
  body?: { content?: string };
}

export interface SendMessageOptions {
  /** Enable streaming mode. Default: false. */
  enableStreaming?: boolean;
}

/**
 * Send user input to a conversation and get the bot response.
 * Returns the response content string.
 */
export async function sendMessage(
  ctx: AuthContext,
  convoId: string,
  content: string,
  options: SendMessageOptions = {},
): Promise<string> {
  const url = normalizeUrl(ctx.baseUrl);
  const res = await fetch(`${url}/cortex/completions/v2/user-input`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(ctx.token, ctx.orgId),
    },
    body: JSON.stringify({
      convoId,
      content,
      sessionId: crypto.randomUUID(),
      messageType: "user-question",
      enableStreaming: options.enableStreaming ?? false,
    }),
  });

  if (!res.ok) throw new Error(`API ${res.status}`);

  const data = (await res.json()) as MessageResponse;
  if (!data?.body?.content) throw new Error("No response received from bot.");

  return data.body.content;
}
