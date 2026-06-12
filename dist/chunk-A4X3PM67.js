import {
  AGENTIC_BASE_URL
} from "./chunk-6GWCCXNN.js";

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
  })).filter((bot) => bot.name !== "Nexus Mobile App");
}
async function fetchBotDetail(ctx, botId) {
  const endpoint = `/cortex/active-bot/${encodeURIComponent(botId)}`;
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
  const raw = data.body ?? data;
  return {
    id: raw._id ?? raw.id ?? botId,
    name: raw.name ?? raw.displayName ?? "",
    model: raw.model ?? "",
    agent: raw.agent ?? null,
    customAgentId: raw.customAgentId ?? null
  };
}

// src/api/conversations.ts
async function getConversationDetail(ctx, convoId) {
  const endpoint = `/cortex/conversation/${encodeURIComponent(convoId)}/general-info`;
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
  const envelope = await res.json();
  const data = envelope.body ?? envelope;
  return {
    agent: data.agent ?? null,
    customAgentId: data.customAgentId ?? null
  };
}
async function createConversation(ctx, botId, convoName = "BlockBrain Conversation") {
  let agentId = null;
  try {
    const botDetail = await fetchBotDetail(ctx, botId);
    agentId = botDetail.agent && botDetail.agent.length > 0 ? botDetail.agent : null;
  } catch {
  }
  const endpoint = `/cortex/active-bot/${encodeURIComponent(botId)}/convo`;
  const url = normalizeUrl(ctx.baseUrl);
  const res = await fetch(`${url}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(ctx.token, ctx.orgId)
    },
    body: JSON.stringify({
      convoName,
      ...agentId !== null && { agent: agentId }
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

// src/api/agentic/headers.ts
function agenticHeaders(options) {
  const base = authHeaders(options.token, options.orgId);
  const headers = {
    ...base,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "X-BLOCKBRAIN-ORGANIZATION-ID": options.organizationId,
    "X-BLOCKBRAIN-DATA-ROOM-ID": options.conversationId
  };
  if (options.botId) {
    headers["X-BLOCKBRAIN-ACTIVE-BOT-ID"] = options.botId;
  }
  return headers;
}

// src/api/agentic/types.ts
function isTextDeltaFrame(frame) {
  return frame.type === "text-delta";
}
function isToolCallApprovalFrame(frame) {
  return frame.type === "data-tool-call-approval";
}
function isToolCallSuspendedFrame(frame) {
  return frame.type === "data-tool-call-suspended";
}
function parseSseDataLine(raw) {
  if (!raw || raw === "[DONE]") return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.type !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

// src/api/agentic/sse.ts
async function* parseAgenticStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const rawEvent of parts) {
        const frames = extractFramesFromRawEvent(rawEvent);
        for (const frame of frames) {
          if (frame === null) continue;
          yield frame;
        }
      }
    }
    if (buffer.trim()) {
      const frames = extractFramesFromRawEvent(buffer);
      for (const frame of frames) {
        if (frame === null) continue;
        yield frame;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
function extractFramesFromRawEvent(rawEvent) {
  const results = [];
  for (const line of rawEvent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trimStart();
    if (payload === "[DONE]") {
      continue;
    }
    results.push(parseSseDataLine(payload));
  }
  return results;
}

// src/api/agentic/client.ts
var autoApproveResolver = {
  async resolveApproval(_ctx) {
    return { approved: true };
  },
  async resolveSuspend(_ctx) {
    return { answers: {} };
  }
};
var DEFAULT_MAX_AUTO_RESUMES = 3;
function buildAgenticStreamUrl(baseUrl, agentId) {
  const v2Base = normalizeUrl(baseUrl).replace(/\/api\/?$/, "/v2/api");
  return `${v2Base}/agents/${encodeURIComponent(agentId)}/stream`;
}
function makeUserMessage(content) {
  return {
    id: crypto.randomUUID(),
    role: "user",
    content,
    parts: [{ type: "text", text: content }]
  };
}
async function postAgenticStream(url, headers, body) {
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  if (!res.ok || !res.body) {
    let responseBody;
    try {
      responseBody = await res.json();
    } catch {
    }
    throw new BBApiError(
      `Agentic API ${res.status} at ${url}`,
      res.status,
      { endpoint: url, responseBody }
    );
  }
  return parseAgenticStream(res.body);
}
async function* callAgenticStream(options) {
  const {
    token,
    orgId,
    agentId,
    convoId,
    userId,
    content,
    botId,
    agenticBaseUrl = AGENTIC_BASE_URL,
    approvalResolver = autoApproveResolver,
    maxAutoResumes = DEFAULT_MAX_AUTO_RESUMES
  } = options;
  const url = buildAgenticStreamUrl(agenticBaseUrl, agentId);
  const headers = agenticHeaders({
    token,
    orgId,
    organizationId: orgId,
    conversationId: convoId,
    botId
  });
  const userMessage = makeUserMessage(content);
  const requestId = crypto.randomUUID();
  let body = {
    id: requestId,
    messages: [userMessage],
    threadId: convoId,
    resourceId: userId
  };
  let resumeCount = 0;
  while (true) {
    const frames = await postAgenticStream(url, headers, body);
    let approvalData = null;
    let suspendData = null;
    for await (const frame of frames) {
      if (isTextDeltaFrame(frame)) {
        const delta = frame.textDelta ?? frame.delta ?? "";
        if (delta) yield delta;
        continue;
      }
      if (isToolCallApprovalFrame(frame)) {
        approvalData = frame.data;
        continue;
      }
      if (isToolCallSuspendedFrame(frame)) {
        suspendData = frame.data;
        continue;
      }
    }
    if (approvalData !== null) {
      if (resumeCount >= maxAutoResumes) break;
      resumeCount++;
      const result = await approvalResolver.resolveApproval(approvalData);
      const resumeData = { approved: result.approved };
      body = {
        id: requestId,
        messages: [userMessage],
        threadId: convoId,
        resourceId: userId,
        runId: approvalData.runId,
        resumeData
      };
      continue;
    }
    if (suspendData !== null) {
      if (resumeCount >= maxAutoResumes) break;
      resumeCount++;
      const result = await approvalResolver.resolveSuspend(suspendData);
      const resumeData = result.cancelled ? { __cancelled: true } : { answers: result.answers ?? {} };
      body = {
        id: requestId,
        messages: [userMessage],
        threadId: convoId,
        resourceId: userId,
        runId: suspendData.runId,
        resumeData
      };
      continue;
    }
    break;
  }
}

// src/api/blocky-sse.ts
async function* parseBlockySseStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  try {
    while (!done) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r\n\r\n|\n\n/);
      buffer = parts.pop() ?? "";
      for (const rawEvent of parts) {
        const result = extractBlockyToken(rawEvent);
        if (result.isDone) {
          done = true;
          break;
        }
        if (result.token !== null) yield result.token;
      }
    }
    if (!done && buffer.trim()) {
      const result = extractBlockyToken(buffer);
      if (result.token !== null) yield result.token;
    }
  } finally {
    reader.releaseLock();
  }
}
function extractBlockyToken(rawEvent) {
  const lines = rawEvent.split(/\r?\n/);
  let eventType = null;
  let dataPayload = null;
  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventType = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataPayload = line.slice(5).trim();
    }
  }
  if (eventType === "message_ready") {
    return { token: null, isDone: true };
  }
  if (eventType === "new_token" && dataPayload !== null) {
    try {
      const parsed = JSON.parse(dataPayload);
      const token = parsed.token ?? null;
      if (token !== null) return { token, isDone: false };
    } catch {
    }
  }
  return { token: null, isDone: false };
}

// src/api/stream-result.ts
function wrapStringAsStream(text) {
  async function* singleDelta() {
    yield text;
  }
  return {
    textDeltas: singleDelta(),
    final: Promise.resolve(text)
  };
}
function createMessageStream(source) {
  const queue = [];
  let doneSignal = false;
  let drainError = null;
  let notifyConsumer = null;
  function notify() {
    const fn = notifyConsumer;
    notifyConsumer = null;
    fn?.();
  }
  let resolveFinale;
  let rejectFinale;
  const final = new Promise((res, rej) => {
    resolveFinale = res;
    rejectFinale = rej;
  });
  void final.catch(() => {
  });
  const accumulated = [];
  (async () => {
    try {
      for await (const delta of source) {
        accumulated.push(delta);
        queue.push(delta);
        notify();
      }
      doneSignal = true;
      notify();
      resolveFinale(accumulated.join(""));
    } catch (err) {
      drainError = err;
      doneSignal = true;
      notify();
      rejectFinale(err);
    }
  })();
  async function* textDeltas() {
    let index = 0;
    while (true) {
      while (index < queue.length) {
        yield queue[index++];
      }
      if (doneSignal) {
        if (drainError !== null) throw drainError;
        break;
      }
      await new Promise((resolve) => {
        notifyConsumer = resolve;
      });
    }
  }
  return {
    textDeltas: textDeltas(),
    final
  };
}

// src/api/messages.ts
var convoDetailCache = /* @__PURE__ */ new Map();
var CACHE_TTL_MS = 5 * 60 * 1e3;
async function getCachedConvoAgent(ctx, convoId) {
  const cached = convoDetailCache.get(convoId);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.agent;
  }
  const detail = await getConversationDetail(ctx, convoId);
  const agent = detail.agent ?? null;
  convoDetailCache.set(convoId, { agent, cachedAt: Date.now() });
  return agent;
}
function invalidateConvoDetailCache(convoId) {
  convoDetailCache.delete(convoId);
}
async function sendMessage(ctx, convoId, content, options = {}) {
  const streaming = options.enableStreaming === true;
  const agentId = await getCachedConvoAgent(ctx, convoId);
  if (agentId) {
    if (!ctx.userId) {
      throw new Error(
        "Agentic API requires OAuth context with a userId. Pass `config.userId = profile.sub` to `getAuthContext` during login."
      );
    }
    const deltaSource = callAgenticStream({
      token: ctx.token,
      orgId: ctx.orgId,
      agentId,
      convoId,
      userId: ctx.userId,
      content,
      // botId is not available from /general-info; X-BLOCKBRAIN-ACTIVE-BOT-ID
      // is sent conditionally — absent here means the header is omitted.
      botId: null,
      approvalResolver: options.approvalResolver
    });
    if (streaming) {
      return createMessageStream(deltaSource);
    }
    let text = "";
    for await (const delta of deltaSource) {
      text += delta;
    }
    return text;
  }
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
      enableStreaming: streaming
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
  if (streaming) {
    if (!res.body) throw new Error("Blocky returned empty body for streaming request.");
    return createMessageStream(parseBlockySseStream(res.body));
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
  fetchBotDetail,
  getConversationDetail,
  createConversation,
  deleteConversation,
  uploadConversationAttachment,
  getConversationAttachments,
  updateConversation,
  createNote,
  wrapStringAsStream,
  createMessageStream,
  invalidateConvoDetailCache,
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
//# sourceMappingURL=chunk-A4X3PM67.js.map