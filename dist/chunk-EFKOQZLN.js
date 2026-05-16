import {
  ACTION_SYSTEM_PROMPT
} from "./chunk-C25NYCKP.js";

// src/prompt/page-prompt.ts
function buildPagePrompt(userText, page, cspMode) {
  const pageContext = `CURRENT PAGE:
- Title: ${page.title}
- URL: ${page.url}

PAGE HTML (cleaned):
${page.html ?? page.text ?? ""}

USER REQUEST:
${userText}`;
  if (cspMode === "actions-only") {
    return `You are a web page assistant. This page has a strict Content Security Policy that blocks JavaScript eval. You cannot provide JavaScript code \u2014 use the Action Library instead.

${pageContext}

INSTRUCTIONS:
For **action requests** ("Make headings red", "Hide the sidebar", "Click the login button"):
${ACTION_SYSTEM_PROMPT}

For **questions** ("What is this page about?", "Summarize this"):
Respond with plain markdown text. No JSON block needed.

The page HTML above is your source of truth.`;
  }
  return `You are a web page assistant. You can answer questions about the page or perform actions on it.

${pageContext}

INSTRUCTIONS:
Decide based on intent:

**Q&A / Explanation** ("What is this page about?", "Summarize this", "Find emails"):
- Respond with plain markdown. No code fence.

**Actions** ("Make headings red", "Hide the sidebar", "Click the login button"):
- Brief explanation (1-2 sentences), then JavaScript in a \`\`\`javascript code fence.
- Full DOM access. Top-level await supported. \`waitFor(selector, timeout?)\` available.

**Combined** ("Summarize and hide images"):
- Markdown answer first, then \`\`\`javascript code fence.

The page HTML is your source of truth. Never invent content not on the page.`;
}

// src/prompt/email-prompt.ts
function parseSubjectAndBody(content) {
  const full = content.match(/^\s*Subject:\s*(.+?)\r?\n\r?\n([\s\S]*)$/);
  if (full) return { subject: full[1].trim(), body: full[2].trim() };
  const single = content.match(/^\s*Subject:\s*(.+?)\r?\n([\s\S]*)$/);
  if (single) return { subject: single[1].trim(), body: single[2].trim() };
  return { subject: "", body: content };
}
function buildEmailPrompt(ctx) {
  const { mailboxOwner, subject, participants, body, userIntent, useSystemPrompt } = ctx;
  let prompt = "";
  if (mailboxOwner?.displayName && mailboxOwner?.email) {
    prompt += `YOUR ROLE: You are writing on behalf of ${mailboxOwner.displayName} <${mailboxOwner.email}>. Compose an appropriate reply on their behalf.

`;
  } else {
    prompt += "YOUR ROLE: You are the recipient of the most recent message. Compose an appropriate reply on their behalf.\n\n";
  }
  if (useSystemPrompt) {
    prompt += "Analyze the following email thread. Identify the MOST RECENT incoming message as well as its sender and context (e.g. private, business, boss, colleague, customer, partner, friend).\n\nRESPONSE RULES:\n- Match the tone of the original email (formal, semi-formal, casual).\n- Write in the first-person perspective of the mailbox owner.\n- Be concise and action-oriented \u2014 avoid filler phrases.\n- Respond in the same language as the incoming email.\n- If critical information is missing, write a professional holding reply with clear placeholders (e.g. [DATE], [DETAILS]).\n- Never fabricate facts, commitments, or figures not present in the original email.\n\nThe reply MUST follow this structure:\n  1. Greeting (e.g. 'Dear Mr/Ms ...', 'Hi ...', 'Hello ...' \u2014 matching the context and tone of the email)\n  2. Body (address all points raised)\n  3. Closing with name (e.g. 'Best regards', 'Kind regards', 'Cheers' \u2014 matching the context)\n\nOUTPUT FORMAT:\nReturn the finished email only \u2014 no analysis, no introduction, no summary, no labels, no extra commentary, no metadata.\nPLAIN TEXT ONLY. You MUST NOT use any markdown syntax whatsoever: no **bold**, no *italic*, no _underscore_, no # headings, no - or * bullet lists, no numbered lists, no `backticks`, no > blockquotes, no --- dividers, no HTML tags. Use plain prose. If line breaks are needed, use a blank line between paragraphs. Just the email text, ready to send.\n\n";
  }
  if (userIntent) {
    prompt += `ADDITIONAL HINTS FROM USER:
${userIntent}

`;
  }
  prompt += `EMAIL THREAD:
Subject: ${subject}
`;
  if (participants?.from?.displayName && participants.from.email) {
    prompt += `From: ${participants.from.displayName} <${participants.from.email}>
`;
  }
  if (participants?.to?.length) {
    const toList = participants.to.map((r) => `${r.displayName ?? ""} <${r.email ?? ""}>`).join(", ");
    prompt += `To: ${toList}
`;
  }
  if (participants?.cc?.length) {
    const ccList = participants.cc.map((r) => `${r.displayName ?? ""} <${r.email ?? ""}>`).join(", ");
    prompt += `Cc: ${ccList}
`;
  }
  prompt += `
Content:
${body}`;
  return prompt;
}
function buildNewEmailPrompt(ctx) {
  const { mailboxOwner, userIntent, useSystemPrompt } = ctx;
  let prompt = "";
  if (mailboxOwner?.displayName && mailboxOwner?.email) {
    prompt += `YOUR ROLE: You are writing a NEW email on behalf of ${mailboxOwner.displayName} <${mailboxOwner.email}>. Compose a professional, ready-to-send message based on the instructions below.

`;
  } else {
    prompt += "YOUR ROLE: You are writing a NEW email on behalf of the sender. Compose a professional, ready-to-send message based on the instructions below.\n\n";
  }
  if (useSystemPrompt) {
    prompt += "COMPOSITION RULES:\n- Write in the first-person perspective of the sender.\n- Be concise and action-oriented \u2014 avoid filler phrases.\n- Match the language of the user's instructions (default: the mailbox owner's language).\n- If the recipient is unknown, use [RECIPIENT NAME] as a placeholder.\n- Use clear placeholders (e.g. [DATE], [DETAILS]) for any information the user has not provided.\n- Never fabricate facts, commitments, or figures.\n\nThe email MUST follow this structure:\n  1. Subject line as the very first line: 'Subject: <subject>'\n  2. A blank line\n  3. Greeting\n  4. Body\n  5. Closing with name\n\nOUTPUT FORMAT:\nReturn only the subject line followed by the email text \u2014 no analysis, no introduction, no summary, no extra commentary.\nPLAIN TEXT ONLY. You MUST NOT use any markdown syntax whatsoever: no **bold**, no *italic*, no _underscore_, no # headings, no - or * bullet lists, no numbered lists, no `backticks`, no > blockquotes, no --- dividers, no HTML tags. Use plain prose. If line breaks are needed, use a blank line between paragraphs.\n\n";
  } else {
    prompt += "FORMAT: Begin with exactly one line 'Subject: <subject>', then a blank line, then the email text.\n\n";
  }
  prompt += `USER INSTRUCTIONS:
${userIntent.trim() || "(none provided \u2014 write a short, polite placeholder email the user can edit)"}
`;
  return prompt;
}

// src/prompt/parse-response.ts
function parseResponse(botText) {
  const jsMatch = botText.match(/```(?:javascript|js)\s*\n([\s\S]*?)```/);
  if (jsMatch) {
    return {
      mode: "js",
      code: jsMatch[1].trim(),
      explanation: botText.slice(0, jsMatch.index).trim()
    };
  }
  const jsonMatch = botText.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (parsed?.type === "actions" && Array.isArray(parsed.steps)) {
        return {
          mode: "actions",
          steps: parsed.steps,
          explanation: botText.slice(0, jsonMatch.index).trim()
        };
      }
    } catch {
    }
  }
  return { mode: "markdown", text: botText };
}

export {
  buildPagePrompt,
  parseSubjectAndBody,
  buildEmailPrompt,
  buildNewEmailPrompt,
  parseResponse
};
//# sourceMappingURL=chunk-EFKOQZLN.js.map