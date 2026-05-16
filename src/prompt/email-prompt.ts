/** Parse bot output of the form "Subject: ...\n\n<body>". */
export function parseSubjectAndBody(content: string): { subject: string; body: string } {
  const full = content.match(/^\s*Subject:\s*(.+?)\r?\n\r?\n([\s\S]*)$/);
  if (full) return { subject: full[1].trim(), body: full[2].trim() };
  const single = content.match(/^\s*Subject:\s*(.+?)\r?\n([\s\S]*)$/);
  if (single) return { subject: single[1].trim(), body: single[2].trim() };
  return { subject: "", body: content };
}

export interface EmailContext {
  mailboxOwner: { email?: string; displayName?: string } | null;
  subject: string;
  participants?: {
    from?: { displayName?: string; email?: string };
    to?: Array<{ displayName?: string; email?: string }>;
    cc?: Array<{ displayName?: string; email?: string }>;
  };
  body: string;
  userIntent: string;
  useSystemPrompt: boolean;
}

export interface NewEmailContext {
  mailboxOwner: { email?: string; displayName?: string } | null;
  userIntent: string;
  useSystemPrompt: boolean;
}

/** Build the LLM prompt for email reply generation. */
export function buildEmailPrompt(ctx: EmailContext): string {
  const { mailboxOwner, subject, participants, body, userIntent, useSystemPrompt } = ctx;

  let prompt = "";

  if (mailboxOwner?.displayName && mailboxOwner?.email) {
    prompt +=
      `YOUR ROLE: You are writing on behalf of ${mailboxOwner.displayName} <${mailboxOwner.email}>. ` +
      "Compose an appropriate reply on their behalf.\n\n";
  } else {
    prompt +=
      "YOUR ROLE: You are the recipient of the most recent message. Compose an appropriate reply on their behalf.\n\n";
  }

  if (useSystemPrompt) {
    prompt +=
      "Analyze the following email thread. Identify the MOST RECENT incoming message " +
      "as well as its sender and context (e.g. private, business, boss, colleague, customer, partner, friend).\n\n" +
      "RESPONSE RULES:\n" +
      "- Match the tone of the original email (formal, semi-formal, casual).\n" +
      "- Write in the first-person perspective of the mailbox owner.\n" +
      "- Be concise and action-oriented — avoid filler phrases.\n" +
      "- Respond in the same language as the incoming email.\n" +
      "- If critical information is missing, write a professional holding reply with clear placeholders (e.g. [DATE], [DETAILS]).\n" +
      "- Never fabricate facts, commitments, or figures not present in the original email.\n\n" +
      "The reply MUST follow this structure:\n" +
      "  1. Greeting (e.g. 'Dear Mr/Ms ...', 'Hi ...', 'Hello ...' — matching the context and tone of the email)\n" +
      "  2. Body (address all points raised)\n" +
      "  3. Closing with name (e.g. 'Best regards', 'Kind regards', 'Cheers' — matching the context)\n\n" +
      "OUTPUT FORMAT:\n" +
      "Return the finished email only — no analysis, no introduction, no summary, no labels, no extra commentary, no metadata.\n" +
      "PLAIN TEXT ONLY. You MUST NOT use any markdown syntax whatsoever: no **bold**, no *italic*, no _underscore_, no # headings, no - or * bullet lists, no numbered lists, no `backticks`, no > blockquotes, no --- dividers, no HTML tags. " +
      "Use plain prose. If line breaks are needed, use a blank line between paragraphs. Just the email text, ready to send.\n\n";
  }

  if (userIntent) {
    prompt += `ADDITIONAL HINTS FROM USER:\n${userIntent}\n\n`;
  }

  prompt += `EMAIL THREAD:\nSubject: ${subject}\n`;

  if (participants?.from?.displayName && participants.from.email) {
    prompt += `From: ${participants.from.displayName} <${participants.from.email}>\n`;
  }
  if (participants?.to?.length) {
    const toList = participants.to
      .map((r) => `${r.displayName ?? ""} <${r.email ?? ""}>`)
      .join(", ");
    prompt += `To: ${toList}\n`;
  }
  if (participants?.cc?.length) {
    const ccList = participants.cc
      .map((r) => `${r.displayName ?? ""} <${r.email ?? ""}>`)
      .join(", ");
    prompt += `Cc: ${ccList}\n`;
  }

  prompt += `\nContent:\n${body}`;

  return prompt;
}

/** Build the LLM prompt for new email composition. */
export function buildNewEmailPrompt(ctx: NewEmailContext): string {
  const { mailboxOwner, userIntent, useSystemPrompt } = ctx;

  let prompt = "";

  if (mailboxOwner?.displayName && mailboxOwner?.email) {
    prompt +=
      `YOUR ROLE: You are writing a NEW email on behalf of ${mailboxOwner.displayName} <${mailboxOwner.email}>. ` +
      "Compose a professional, ready-to-send message based on the instructions below.\n\n";
  } else {
    prompt +=
      "YOUR ROLE: You are writing a NEW email on behalf of the sender. " +
      "Compose a professional, ready-to-send message based on the instructions below.\n\n";
  }

  if (useSystemPrompt) {
    prompt +=
      "COMPOSITION RULES:\n" +
      "- Write in the first-person perspective of the sender.\n" +
      "- Be concise and action-oriented — avoid filler phrases.\n" +
      "- Match the language of the user's instructions (default: the mailbox owner's language).\n" +
      "- If the recipient is unknown, use [RECIPIENT NAME] as a placeholder.\n" +
      "- Use clear placeholders (e.g. [DATE], [DETAILS]) for any information the user has not provided.\n" +
      "- Never fabricate facts, commitments, or figures.\n\n" +
      "The email MUST follow this structure:\n" +
      "  1. Subject line as the very first line: 'Subject: <subject>'\n" +
      "  2. A blank line\n" +
      "  3. Greeting\n" +
      "  4. Body\n" +
      "  5. Closing with name\n\n" +
      "OUTPUT FORMAT:\n" +
      "Return only the subject line followed by the email text — no analysis, no introduction, no summary, no extra commentary.\n" +
      "PLAIN TEXT ONLY. You MUST NOT use any markdown syntax whatsoever: no **bold**, no *italic*, no _underscore_, no # headings, no - or * bullet lists, no numbered lists, no `backticks`, no > blockquotes, no --- dividers, no HTML tags. " +
      "Use plain prose. If line breaks are needed, use a blank line between paragraphs.\n\n";
  } else {
    prompt +=
      "FORMAT: Begin with exactly one line 'Subject: <subject>', then a blank line, then the email text.\n\n";
  }

  prompt += `USER INSTRUCTIONS:\n${userIntent.trim() || "(none provided — write a short, polite placeholder email the user can edit)"}\n`;

  return prompt;
}
