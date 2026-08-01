import type { AuthContext } from "../settings/auth-mode.js";
import { requestJson } from "./_send.js";
import { authHeaders } from "./headers.js";

export interface Bot {
  id: string;
  name: string;
  model: string;
}

/**
 * Routing-relevant fields from a single bot record.
 * `agent` is the Mastra agent ID — when set, conversations for this bot
 * must carry `agent` in their create payload so `sendMessage` routes to
 * the Agentic path.
 */
export interface BotDetail {
  id: string;
  name: string;
  model: string;
  /** Mastra agent ID; empty string or null when the bot is LLM-only. */
  agent: string | null;
  /** Custom agent ID (distinct from the Mastra agent). */
  customAgentId: string | null;
}

interface RawBot {
  _id?: string;
  id?: string;
  name?: string;
  displayName?: string;
  model?: string;
  agent?: string | null;
  customAgentId?: string | null;
}

interface BotListResponse {
  body?: { data?: RawBot[] } & RawBot[];
}

interface BotDetailResponse {
  body?: RawBot;
}

/** Fetch the list of active bots for the authenticated context. */
export async function fetchBotList(ctx: AuthContext): Promise<Bot[]> {
  const data = await requestJson<BotListResponse>(ctx, {
    host: "blocky",
    path: "/cortex/active-bot/list",
    method: "GET",
    query: { page: 1, size: 100 },
    headers: authHeaders(ctx.token, ctx.orgId),
  });

  let bots: RawBot[] = [];
  if (data.body?.data && Array.isArray(data.body.data)) {
    bots = data.body.data;
  } else if (Array.isArray(data.body)) {
    bots = data.body;
  } else if (Array.isArray(data)) {
    bots = data;
  }

  if (bots.length === 0) throw new Error("No bots found.");

  return bots
    .map(bot => ({
      id: bot._id ?? bot.id ?? "",
      name: bot.name ?? bot.displayName ?? bot._id ?? "",
      model: bot.model ?? "",
    }))
    .filter(bot => bot.name !== "Nexus Mobile App");
}

/**
 * Fetch routing-relevant detail for a single bot.
 *
 * GET /cortex/active-bot/{botId}
 *
 * Used internally by `createConversation` to propagate the bot's `agent`
 * field to the new conversation — required so `sendMessage` can route to
 * the Agentic path. Callers that only need the basic `Bot` shape should
 * use `fetchBotList` instead.
 */
export async function fetchBotDetail(ctx: AuthContext, botId: string): Promise<BotDetail> {
  const data = await requestJson<BotDetailResponse>(ctx, {
    host: "blocky",
    path: `/cortex/active-bot/${encodeURIComponent(botId)}`,
    method: "GET",
    headers: authHeaders(ctx.token, ctx.orgId),
  });
  const raw = data.body ?? (data as unknown as RawBot);
  return {
    id: raw._id ?? raw.id ?? botId,
    name: raw.name ?? raw.displayName ?? "",
    model: raw.model ?? "",
    agent: raw.agent ?? null,
    customAgentId: raw.customAgentId ?? null,
  };
}
