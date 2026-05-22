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

// src/api/errors.ts
var BBApiError = class _BBApiError extends Error {
  statusCode;
  endpoint;
  responseBody;
  constructor(message, statusCode, options) {
    super(message);
    this.name = "BBApiError";
    this.statusCode = statusCode;
    this.endpoint = options?.endpoint;
    this.responseBody = options?.responseBody;
    if (options?.cause !== void 0) {
      this.cause = options.cause;
    }
    Object.setPrototypeOf(this, _BBApiError.prototype);
  }
};
function isBBApiError(err) {
  return err instanceof BBApiError;
}

// src/api/introspect.ts
async function introspectApiKey(baseUrl, token) {
  const endpoint = "/auth/introspect_api_key";
  const url = normalizeUrl(baseUrl);
  const res = await fetch(`${url}${endpoint}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`
    }
  });
  if (!res.ok) {
    let body;
    try {
      body = await res.json();
    } catch {
    }
    throw new BBApiError(`API ${res.status} at ${endpoint}`, res.status, { endpoint, responseBody: body });
  }
  const data = await res.json();
  if (data.active !== true) throw new BBApiError("API key is inactive", 401, { endpoint });
  return data;
}
function extractOrgIdFromIntrospect(data) {
  const val = data["urn:zitadel:iam:user:resourceowner:id"];
  return typeof val === "string" ? val : "";
}

// src/api/bots.ts
async function fetchBotList(ctx) {
  const endpoint = "/cortex/active-bot/list";
  const url = normalizeUrl(ctx.baseUrl);
  const res = await fetch(`${url}${endpoint}?page=1&size=100`, {
    method: "GET",
    headers: authHeaders(ctx.token, ctx.orgId)
  });
  if (!res.ok) {
    let body;
    try {
      body = await res.json();
    } catch {
    }
    throw new BBApiError(`API ${res.status} at ${endpoint}`, res.status, { endpoint, responseBody: body });
  }
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
  const endpoint = `/cortex/active-bot/${encodeURIComponent(botId)}/convo`;
  const url = normalizeUrl(ctx.baseUrl);
  const res = await fetch(`${url}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(ctx.token, ctx.orgId)
    },
    body: JSON.stringify({ convoName })
  });
  if (!res.ok) {
    let body;
    try {
      body = await res.json();
    } catch {
    }
    throw new BBApiError(`API ${res.status} at ${endpoint}`, res.status, { endpoint, responseBody: body });
  }
  const data = await res.json();
  return { convoId: data.body.dataRoomId };
}
async function deleteConversation(ctx, convoId) {
  const endpoint = `/cortex/conversation/${encodeURIComponent(convoId)}`;
  const url = normalizeUrl(ctx.baseUrl);
  const res = await fetch(`${url}${endpoint}`, {
    method: "DELETE",
    headers: authHeaders(ctx.token, ctx.orgId)
  });
  if (!res.ok) {
    let body;
    try {
      body = await res.json();
    } catch {
    }
    throw new BBApiError(`API ${res.status} at ${endpoint}`, res.status, { endpoint, responseBody: body });
  }
}
async function uploadConversationAttachment(ctx, convoId, file, sessionId, options) {
  const endpoint = `/cortex/conversation/${encodeURIComponent(convoId)}/attachment`;
  const url = normalizeUrl(ctx.baseUrl);
  const form = new FormData();
  form.append("attachment", file);
  form.append("session_id", sessionId);
  if (options?.isSmartOcr !== void 0) {
    form.append("is_smart_ocr", String(options.isSmartOcr));
  }
  if (options?.isKeepBothDuplicate !== void 0) {
    form.append("is_keep_both_duplicate", String(options.isKeepBothDuplicate));
  }
  if (options?.isOverwriteDuplicate !== void 0) {
    form.append("is_overwrite_duplicate", String(options.isOverwriteDuplicate));
  }
  if (options?.uploadKey !== void 0) {
    form.append("upload_key", options.uploadKey);
  }
  const res = await fetch(`${url}${endpoint}`, {
    method: "POST",
    headers: authHeaders(ctx.token, ctx.orgId),
    body: form
  });
  if (!res.ok) {
    let body;
    try {
      body = await res.json();
    } catch {
    }
    throw new BBApiError(`API ${res.status} at ${endpoint}`, res.status, { endpoint, responseBody: body });
  }
  const envelope = await res.json();
  const data = envelope.body;
  if (!data?._id || !data?.name) {
    throw new BBApiError("Attachment upload response missing required fields", res.status, { endpoint, responseBody: envelope });
  }
  return data;
}
async function getConversationAttachments(ctx, convoId) {
  const endpoint = `/cortex/conversation/${encodeURIComponent(convoId)}/attachment`;
  const url = normalizeUrl(ctx.baseUrl);
  const res = await fetch(`${url}${endpoint}`, {
    method: "GET",
    headers: authHeaders(ctx.token, ctx.orgId)
  });
  if (!res.ok) {
    let body;
    try {
      body = await res.json();
    } catch {
    }
    throw new BBApiError(`API ${res.status} at ${endpoint}`, res.status, { endpoint, responseBody: body });
  }
  const raw = await res.json();
  if (Array.isArray(raw)) return raw;
  const envelope = raw;
  return Array.isArray(envelope.body) ? envelope.body : [];
}
async function updateConversation(ctx, convoId, patch) {
  const endpoint = `/cortex/conversation/${encodeURIComponent(convoId)}`;
  const url = normalizeUrl(ctx.baseUrl);
  const res = await fetch(`${url}${endpoint}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(ctx.token, ctx.orgId)
    },
    body: JSON.stringify(patch)
  });
  if (!res.ok) {
    let body;
    try {
      body = await res.json();
    } catch {
    }
    throw new BBApiError(`API ${res.status} at ${endpoint}`, res.status, { endpoint, responseBody: body });
  }
}

// src/api/notes.ts
async function createNote(ctx, params) {
  const endpoint = "/cortex/notes/add-note";
  const url = normalizeUrl(ctx.baseUrl);
  const res = await fetch(`${url}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(ctx.token, ctx.orgId)
    },
    body: JSON.stringify({
      title: params.title,
      summary: params.summary,
      parent_path: params.parentPath,
      is_ai_generated: params.isAiGenerated ?? false
    })
  });
  if (!res.ok) {
    let body;
    try {
      body = await res.json();
    } catch {
    }
    throw new BBApiError(`API ${res.status} at ${endpoint}`, res.status, { endpoint, responseBody: body });
  }
  const envelope = await res.json();
  const data = envelope.body;
  if (!data?._id) {
    throw new BBApiError("Note create response missing _id", res.status, { endpoint, responseBody: envelope });
  }
  return data;
}

// src/api/messages.ts
async function sendMessage(ctx, convoId, content, options = {}) {
  const endpoint = "/cortex/completions/v2/user-input";
  const url = normalizeUrl(ctx.baseUrl);
  const res = await fetch(`${url}${endpoint}`, {
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
  if (!res.ok) {
    let body;
    try {
      body = await res.json();
    } catch {
    }
    throw new BBApiError(`API ${res.status} at ${endpoint}`, res.status, { endpoint, responseBody: body });
  }
  const data = await res.json();
  if (!data?.body?.content) throw new Error("No response received from bot.");
  return data.body.content;
}
async function getMessageList(ctx, convoId, options = {}) {
  const endpoint = "/cortex/message/list";
  const url = normalizeUrl(ctx.baseUrl);
  const res = await fetch(`${url}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(ctx.token, ctx.orgId)
    },
    body: JSON.stringify({
      convoId,
      keyword: options.keyword ?? "",
      page: options.page ?? 1,
      size: options.size ?? 20
    })
  });
  if (!res.ok) {
    let body;
    try {
      body = await res.json();
    } catch {
    }
    throw new BBApiError(`API ${res.status} at ${endpoint}`, res.status, { endpoint, responseBody: body });
  }
  const data = await res.json();
  return data.body;
}

// src/api/transcribe.ts
async function transcribeAudio(ctx, audio, filename = "recording.webm", model = "azure-whisper") {
  const endpoint = "/sp2text/generate";
  const url = normalizeUrl(ctx.baseUrl);
  const form = new FormData();
  form.append("file", audio, filename);
  form.append("model", model);
  const headers = authHeaders(ctx.token, ctx.orgId);
  delete headers["Accept"];
  const res = await fetch(`${url}${endpoint}`, {
    method: "POST",
    headers,
    body: form
  });
  if (!res.ok) {
    let body;
    try {
      body = await res.json();
    } catch {
    }
    throw new BBApiError(`API ${res.status} at ${endpoint}`, res.status, { endpoint, responseBody: body });
  }
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
async function listTenants(ctx, options) {
  const endpoint = "/tenant";
  const params = new URLSearchParams({
    name: options?.name ?? "",
    page: String(options?.page ?? 1),
    size: String(options?.size ?? 20)
  });
  const res = await fetch(`${normalizeUrl(ctx.baseUrl)}${endpoint}?${params}`, {
    method: "GET",
    headers: authHeaders(ctx.token, ctx.orgId)
  });
  if (!res.ok) {
    let body;
    try {
      body = await res.json();
    } catch {
    }
    throw new BBApiError(`Tenant list failed: ${res.status}`, res.status, { endpoint, responseBody: body });
  }
  const json = await res.json();
  const payload = json.body ?? json;
  return {
    totalCount: payload.totalCount,
    currentPage: payload.currentPage,
    data: payload.data.map((t) => ({
      id: t._id ?? t.id ?? "",
      tenantName: t.tenantName,
      database: t.database,
      activePlan: t.activePlan,
      domain: t.domain,
      acceptSuffix: t.acceptSuffix ?? []
    }))
  };
}
async function getTenantById(ctx, tenantId) {
  const endpoint = `/tenant/${tenantId}`;
  const res = await fetch(`${normalizeUrl(ctx.baseUrl)}${endpoint}`, {
    method: "GET",
    headers: authHeaders(ctx.token, ctx.orgId)
  });
  if (!res.ok) {
    let body;
    try {
      body = await res.json();
    } catch {
    }
    throw new BBApiError(`Tenant detail failed: ${res.status}`, res.status, { endpoint, responseBody: body });
  }
  const json = await res.json();
  const t = json.body ?? json;
  return {
    id: t._id ?? t.id ?? "",
    tenantName: t.tenantName ?? "",
    database: t.database,
    activePlan: t.activePlan,
    domain: t.domain,
    acceptSuffix: t.acceptSuffix ?? [],
    zitadelOrgId: t.zitadelOrgId
  };
}

// src/api/websearch.ts
async function getAvailableWebSearchProviders(ctx) {
  const endpoint = "/cortex/web-search/provider";
  const url = normalizeUrl(ctx.baseUrl);
  const res = await fetch(`${url}${endpoint}`, {
    method: "GET",
    headers: authHeaders(ctx.token, ctx.orgId)
  });
  if (!res.ok) {
    let body;
    try {
      body = await res.json();
    } catch {
    }
    throw new BBApiError(`API ${res.status} at ${endpoint}`, res.status, { endpoint, responseBody: body });
  }
  return await res.json();
}
async function setConversationWebSearch(ctx, convoId, settings) {
  const endpoint = `/cortex/conversation/${convoId}`;
  const url = normalizeUrl(ctx.baseUrl);
  const res = await fetch(`${url}${endpoint}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(ctx.token, ctx.orgId)
    },
    body: JSON.stringify(settings)
  });
  if (!res.ok) {
    let body;
    try {
      body = await res.json();
    } catch {
    }
    throw new BBApiError(`API ${res.status} at ${endpoint}`, res.status, { endpoint, responseBody: body });
  }
}
async function getConversationWebSearch(ctx, convoId) {
  const endpoint = `/cortex/conversation/${convoId}`;
  const url = normalizeUrl(ctx.baseUrl);
  const res = await fetch(`${url}${endpoint}`, {
    method: "GET",
    headers: authHeaders(ctx.token, ctx.orgId)
  });
  if (!res.ok) {
    let body;
    try {
      body = await res.json();
    } catch {
    }
    throw new BBApiError(`API ${res.status} at ${endpoint}`, res.status, { endpoint, responseBody: body });
  }
  const data = await res.json();
  const payload = data.body ?? data;
  return {
    enableWebSearch: payload.enableWebSearch,
    webSearchType: payload.webSearchType,
    webSearchConfig: payload.webSearchConfig
  };
}

// src/api/_auth-headers.ts
function bbApiAuthHeaders(ctx) {
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${ctx.token}`
  };
  if (ctx.mode === "oauth") {
    headers["x-zitadel-org-id"] = ctx.orgId;
  }
  return headers;
}
async function throwIfNotOk(res, endpoint) {
  if (!res.ok) {
    let body;
    try {
      body = await res.json();
    } catch {
    }
    throw new BBApiError(`API ${res.status} at ${endpoint}`, res.status, { endpoint, responseBody: body });
  }
}

// src/api/agents.ts
function buildUrl(ctx, path, targetOrgId, extra = {}) {
  const base = normalizeUrl(ctx.baseUrl);
  const params = new URLSearchParams(extra);
  params.set("orgId", targetOrgId ?? ctx.orgId);
  return `${base}/${path}?${params.toString()}`;
}
async function fetchAgents(ctx, targetOrgId) {
  const endpoint = "agents";
  const url = buildUrl(ctx, endpoint, targetOrgId, {
    includeInactive: "true",
    includeUnavailable: "true"
  });
  const res = await fetch(url, {
    method: "GET",
    headers: bbApiAuthHeaders(ctx)
  });
  await throwIfNotOk(res, endpoint);
  return res.json();
}
async function setAgentActive(ctx, agentId, active, targetOrgId) {
  const endpoint = "agents/set-active";
  const url = buildUrl(ctx, endpoint, targetOrgId);
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...bbApiAuthHeaders(ctx) },
    body: JSON.stringify({ agentId, active })
  });
  await throwIfNotOk(res, endpoint);
  return res.json();
}
async function setAgentAvailability(ctx, agentId, available, targetOrgId) {
  const endpoint = "agents/set-availability";
  const url = buildUrl(ctx, endpoint, targetOrgId);
  const effectiveOrgId = targetOrgId ?? ctx.orgId;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...bbApiAuthHeaders(ctx) },
    body: JSON.stringify({ agentId, available, orgId: effectiveOrgId })
  });
  await throwIfNotOk(res, endpoint);
  return res.json();
}

// src/api/capabilities.ts
function buildUrl2(ctx, path, targetOrgId, extra = {}) {
  const base = normalizeUrl(ctx.baseUrl);
  const params = new URLSearchParams(extra);
  params.set("orgId", targetOrgId ?? ctx.orgId);
  return `${base}/${path}?${params.toString()}`;
}
async function fetchCapabilities(ctx, targetOrgId) {
  const endpoint = "capabilities";
  const url = buildUrl2(ctx, endpoint, targetOrgId, { includeInactive: "true", includeUnavailable: "true" });
  const res = await fetch(url, {
    method: "GET",
    headers: bbApiAuthHeaders(ctx)
  });
  await throwIfNotOk(res, endpoint);
  return res.json();
}
async function setCapabilityActive(ctx, capabilityId, active, targetOrgId) {
  const endpoint = "capabilities/set-active";
  const url = buildUrl2(ctx, endpoint, targetOrgId);
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...bbApiAuthHeaders(ctx) },
    body: JSON.stringify({ capabilityId, active })
  });
  await throwIfNotOk(res, endpoint);
  return res.json();
}
async function setCapabilityAvailability(ctx, capabilityId, available, targetOrgId) {
  const endpoint = "capabilities/set-availability";
  const url = buildUrl2(ctx, endpoint, targetOrgId);
  const effectiveOrgId = targetOrgId ?? ctx.orgId;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...bbApiAuthHeaders(ctx) },
    body: JSON.stringify({ capabilityId, available, orgId: effectiveOrgId })
  });
  await throwIfNotOk(res, endpoint);
  return res.json();
}

// src/api/tenant-config.ts
async function getTenantConfig(ctx, targetOrgId) {
  const endpoint = "tenants";
  const base = normalizeUrl(ctx.baseUrl);
  const params = new URLSearchParams({ orgId: targetOrgId ?? ctx.orgId });
  const url = `${base}/${endpoint}?${params.toString()}`;
  const res = await fetch(url, {
    method: "GET",
    headers: bbApiAuthHeaders(ctx)
  });
  await throwIfNotOk(res, endpoint);
  const data = await res.json();
  return { customAgentsEnabled: data.config?.customAgentsEnabled ?? false };
}
async function setCustomAgentsEnabled(ctx, enabled, targetOrgId) {
  const endpoint = "tenants/config";
  const base = normalizeUrl(ctx.baseUrl);
  const params = new URLSearchParams({ orgId: targetOrgId ?? ctx.orgId });
  const url = `${base}/${endpoint}?${params.toString()}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...bbApiAuthHeaders(ctx) },
    body: JSON.stringify({ customAgentsEnabled: enabled })
  });
  await throwIfNotOk(res, endpoint);
}

export {
  authHeaders,
  normalizeUrl,
  BBApiError,
  isBBApiError,
  introspectApiKey,
  extractOrgIdFromIntrospect,
  fetchBotList,
  createConversation,
  deleteConversation,
  uploadConversationAttachment,
  getConversationAttachments,
  updateConversation,
  createNote,
  sendMessage,
  getMessageList,
  transcribeAudio,
  discoverFrontendUrls,
  listTenants,
  getTenantById,
  getAvailableWebSearchProviders,
  setConversationWebSearch,
  getConversationWebSearch,
  fetchAgents,
  setAgentActive,
  setAgentAvailability,
  fetchCapabilities,
  setCapabilityActive,
  setCapabilityAvailability,
  getTenantConfig,
  setCustomAgentsEnabled
};
//# sourceMappingURL=chunk-3MG33L7I.js.map