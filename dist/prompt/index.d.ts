import { b as ActionStep } from '../schema-BJs6_Xa5.js';

interface PageContext {
    title: string;
    url: string;
    meta?: string;
    html?: string;
    text?: string;
}
type CspMode = "js-ok" | "actions-only";
/**
 * Build the LLM prompt for page-manipulation requests.
 * CSP-aware: actions-only mode omits JS instructions and embeds the Action Library spec.
 */
declare function buildPagePrompt(userText: string, page: PageContext, cspMode: CspMode): string;

/** Parse bot output of the form "Subject: ...\n\n<body>". */
declare function parseSubjectAndBody(content: string): {
    subject: string;
    body: string;
};
interface EmailContext {
    mailboxOwner: {
        email?: string;
        displayName?: string;
    } | null;
    subject: string;
    participants?: {
        from?: {
            displayName?: string;
            email?: string;
        };
        to?: Array<{
            displayName?: string;
            email?: string;
        }>;
        cc?: Array<{
            displayName?: string;
            email?: string;
        }>;
    };
    body: string;
    userIntent: string;
    useSystemPrompt: boolean;
}
interface NewEmailContext {
    mailboxOwner: {
        email?: string;
        displayName?: string;
    } | null;
    userIntent: string;
    useSystemPrompt: boolean;
}
/** Build the LLM prompt for email reply generation. */
declare function buildEmailPrompt(ctx: EmailContext): string;
/** Build the LLM prompt for new email composition. */
declare function buildNewEmailPrompt(ctx: NewEmailContext): string;

type ParsedResponse = {
    mode: "js";
    code: string;
    explanation: string;
} | {
    mode: "actions";
    steps: ActionStep[];
    explanation: string;
} | {
    mode: "markdown";
    text: string;
};
/**
 * Detect the response mode from LLM bot output.
 *
 * Priority:
 * 1. ```javascript / ```js fence → JS mode
 * 2. ```json fence with { type: "actions", steps: [] } → actions mode
 * 3. Everything else → markdown
 */
declare function parseResponse(botText: string): ParsedResponse;

export { type CspMode, type EmailContext, type NewEmailContext, type PageContext, type ParsedResponse, buildEmailPrompt, buildNewEmailPrompt, buildPagePrompt, parseResponse, parseSubjectAndBody };
