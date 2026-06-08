import { authHeaders } from "./headers.js";
import { normalizeUrl } from "./url.js";
import { BBApiError } from "./errors.js";
import type { AuthContext } from "../settings/auth-mode.js";

export interface Bot {
  id: string;
  name: string;
  model: string;
}

interface RawBot {
  _id?: string;
  id?: string;
  name?: string;
  displayName?: string;
  model?: string;
}

interface BotListResponse {
  body?: { data?: RawBot[] } & RawBot[];
}

/** Fetch the list of active bots for the authenticated context. */
export async function fetchBotList(ctx: AuthContext): Promise<Bot[]> {
  const endpoint = "/cortex/active-bot/list";
  const url = normalizeUrl(ctx.baseUrl);
  const res = await fetch(`${url}${endpoint}?page=1&size=100`, {
    method: "GET",
    headers: authHeaders(ctx.token, ctx.orgId),
  });

  if (!res.ok) {
    let body: unknown;
    try { body = await res.json(); } catch { /* response may not be JSON */ }
    throw new BBApiError(`API ${res.status} at ${endpoint}`, res.status, { endpoint, responseBody: body });
  }

  const data = (await res.json()) as BotListResponse;

  let bots: RawBot[] = [];
  if (data.body?.data && Array.isArray(data.body.data)) {
    bots = data.body.data;
  } else if (Array.isArray(data.body)) {
    bots = data.body;
  } else if (Array.isArray(data)) {
    bots = data as unknown as RawBot[];
  }

  if (bots.length === 0) throw new Error("No bots found.");

  return bots
    .map((bot) => ({
      id: bot._id ?? bot.id ?? "",
      name: bot.name ?? bot.displayName ?? bot._id ?? "",
      model: bot.model ?? "",
    }))
    .filter((bot) => bot.name !== "Nexus Mobile App");
}
