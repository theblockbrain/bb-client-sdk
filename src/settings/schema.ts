import { OAUTH_BACKEND_URL } from "../config.js";

export interface Settings {
  bbUrl: string;
  bbToken: string;
  bbOrgId: string;
  bbBotId: string;
  bbBotName: string;
  useSystemPrompt: boolean;
  authMode: "api-key" | "oauth";
}

export const DEFAULTS: Settings = {
  bbUrl: OAUTH_BACKEND_URL,
  bbToken: "",
  bbOrgId: "",
  bbBotId: "",
  bbBotName: "",
  useSystemPrompt: false,
  authMode: "oauth",
};
