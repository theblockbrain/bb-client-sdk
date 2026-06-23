import { b as ActionStep } from '../schema-BJs6_Xa5.js';

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

export { type ParsedResponse, parseResponse };
