import { authHeaders } from "./headers.js";
import { normalizeUrl } from "./url.js";
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
  const url = normalizeUrl(ctx.baseUrl);
  const res = await fetch(`${url}/cortex/active-bot/list?page=1&size=100`, {
    method: "GET",
    headers: authHeaders(ctx.token, ctx.orgId),
  });

  if (!res.ok) throw new Error(`API returned ${res.status}`);

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

  return bots.map((bot) => ({
    id: bot._id ?? bot.id ?? "",
    name: bot.name ?? bot.displayName ?? bot._id ?? "",
    model: bot.model ?? "",
  }));
}
