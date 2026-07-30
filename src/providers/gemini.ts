import { AccountManager } from "../accounts/manager";
import { TokenData } from "../auth/types";
import { loadAllTokens } from "../auth/token-storage";
import { GeminiConfig } from "../config";
import { callGeminiGenerateContent } from "../upstream/gemini-api";
import { Provider, UpstreamCallContext } from "./types";

const DEFAULT_API_KEY_ENV = "GEMINI_API_KEY";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_API_KEY_ACCOUNT_UUID = "gemini-api-key";
const MODEL_RE = /^gemini-/i;
const ADVERTISED_MODELS = [
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.1-pro-preview",
  "gemini-3-pro-preview",
];

export function makeGeminiApiKeyToken(
  apiKey: string,
  apiKeyEnv: string = DEFAULT_API_KEY_ENV,
): TokenData {
  return {
    accessToken: apiKey,
    refreshToken: "",
    email: `gemini-api-key@${apiKeyEnv.toLowerCase()}`,
    expiresAt: "9999-12-31T23:59:59.999Z",
    accountUuid: GEMINI_API_KEY_ACCOUNT_UUID,
    provider: "google",
  };
}

export function buildGeminiProvider(
  authDir: string,
  config?: GeminiConfig,
): Provider {
  const apiKeyEnv = config?.["api-key-env"] || DEFAULT_API_KEY_ENV;
  const baseUrl = config?.["base-url"] || DEFAULT_BASE_URL;
  const manager = new AccountManager(authDir, {
    provider: "google",
    refresh: async () => {
      throw new Error("Gemini API-key credentials do not support refresh");
    },
  });
  const apiKey = process.env[apiKeyEnv]?.trim();
  const storedTokens = loadAllTokens(authDir, "google");
  if (apiKey && storedTokens.length === 0) {
    manager.addEphemeralAccount(makeGeminiApiKeyToken(apiKey, apiKeyEnv));
  }

  return {
    id: "google",
    nativeFormat: "gemini-generate-content",
    manager,
    matchesModel: (model: string) => MODEL_RE.test(model),
    listModels: async () =>
      manager.accountCount > 0
        ? ADVERTISED_MODELS.map((id) => ({ id, owned_by: "google" }))
        : [],
    callMessages: (opts: UpstreamCallContext) =>
      callGeminiGenerateContent({ ...opts, baseUrl }),
  };
}
