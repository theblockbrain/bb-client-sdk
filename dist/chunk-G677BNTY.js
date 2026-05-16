// src/api/headers.ts
function authHeaders(token, orgId) {
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`
  };
  if (orgId) {
    headers["x-zitadel-org-id"] = orgId;
  }
  return headers;
}

// src/api/url.ts
function normalizeUrl(url) {
  return url.replace(/\/+$/, "");
}

// src/api/introspect.ts
async function introspectApiKey(baseUrl, token) {
  const url = normalizeUrl(baseUrl);
  const res = await fetch(`${url}/auth/introspect_api_key`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.active !== true) throw new Error("API key is inactive");
  return data;
}
function extractOrgIdFromIntrospect(data) {
  const val = data["urn:zitadel:iam:user:resourceowner:id"];
  return typeof val === "string" ? val : "";
}

// src/api/bots.ts
async function fetchBotList(ctx) {
  const url = normalizeUrl(ctx.baseUrl);
  const res = await fetch(`${url}/cortex/active-bot/list?page=1&size=100`, {
    method: "GET",
    headers: authHeaders(ctx.token, ctx.orgId)
  });
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  const data = await res.json();
  let bots = [];
  if (data.body?.data && Array.isArray(data.body.data)) {
    bots = data.body.data;
  } else if (Array.isArray(data.body)) {
    bots = data.body;
  } else if (Array.isArray(data)) {
    bots = data;
  }
  if (bots.length === 0) throw new Error("No bots found.");
  return bots.map((bot) => ({
    id: bot._id ?? bot.id ?? "",
    name: bot.name ?? bot.displayName ?? bot._id ?? "",
    model: bot.model ?? ""
  }));
}

// src/api/conversations.ts
async function createConversation(ctx, botId, convoName = "BlockBrain Conversation") {
  const url = normalizeUrl(ctx.baseUrl);
  const res = await fetch(`${url}/cortex/active-bot/${botId}/convo`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(ctx.token, ctx.orgId)
    },
    body: JSON.stringify({ convoName })
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  const data = await res.json();
  return { convoId: data.body.dataRoomId };
}

// src/api/messages.ts
async function sendMessage(ctx, convoId, content, options = {}) {
  const url = normalizeUrl(ctx.baseUrl);
  const res = await fetch(`${url}/cortex/completions/v2/user-input`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(ctx.token, ctx.orgId)
    },
    body: JSON.stringify({
      convoId,
      content,
      sessionId: crypto.randomUUID(),
      messageType: "user-question",
      enableStreaming: options.enableStreaming ?? false
    })
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  const data = await res.json();
  if (!data?.body?.content) throw new Error("No response received from bot.");
  return data.body.content;
}

// src/api/transcribe.ts
async function transcribeAudio(ctx, audio, filename = "recording.webm", model = "azure-whisper") {
  const url = normalizeUrl(ctx.baseUrl);
  const form = new FormData();
  form.append("file", audio, filename);
  form.append("model", model);
  const headers = authHeaders(ctx.token, ctx.orgId);
  delete headers["Accept"];
  const res = await fetch(`${url}/sp2text/generate`, {
    method: "POST",
    headers,
    body: form
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  const data = await res.json();
  const text = data?.body?.text ?? data?.body?.content ?? data?.text ?? "";
  if (!text) throw new Error("Empty transcription returned.");
  return text.trim();
}

// src/api/tenant.ts
async function discoverFrontendUrls(baseUrl, token, orgId) {
  const url = normalizeUrl(baseUrl);
  try {
    const res = await fetch(`${url}/user-tenant/domains`, {
      headers: {
        ...authHeaders(token, orgId),
        "Content-Type": "application/json"
      }
    });
    if (!res.ok) return null;
    const raw = await res.json();
    const domains = raw.content ?? raw.body ?? (Array.isArray(raw) ? raw : null);
    if (Array.isArray(domains) && domains.length > 0) return domains;
    return null;
  } catch {
    return null;
  }
}

export {
  authHeaders,
  normalizeUrl,
  introspectApiKey,
  extractOrgIdFromIntrospect,
  fetchBotList,
  createConversation,
  sendMessage,
  transcribeAudio,
  discoverFrontendUrls
};
//# sourceMappingURL=chunk-G677BNTY.js.map