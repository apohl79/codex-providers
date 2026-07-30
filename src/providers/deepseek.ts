import { DeepSeekConfig } from "../config";
import { AccountManager } from "../accounts/manager";
import { TokenData } from "../auth/types";
import { loadAllTokens } from "../auth/token-storage";
import { callAnthropicMessagesWithApiKey } from "../upstream/anthropic-api";
import { Provider, UpstreamCallContext } from "./types";

const DEFAULT_API_KEY_ENV = "DEEPSEEK_API_KEY";
const DEFAULT_BASE_URL = "https://api.deepseek.com/anthropic";
const MODEL_RE = /^deepseek-v4-(pro|flash)$/i;
const ADVERTISED_MODELS = ["deepseek-v4-pro", "deepseek-v4-flash"];

export function makeDeepSeekApiKeyToken(
  apiKey: string,
  apiKeyEnv: string = DEFAULT_API_KEY_ENV,
): TokenData {
  return {
    accessToken: apiKey,
    refreshToken: "",
    email: `deepseek-api-key@${apiKeyEnv.toLowerCase()}`,
    expiresAt: "9999-12-31T23:59:59.999Z",
    accountUuid: "deepseek-api-key",
    provider: "deepseek",
  };
}

export function buildDeepSeekProvider(
  authDir: string,
  config?: DeepSeekConfig,
  advertisedModels?: string[],
): Provider {
  const apiKeyEnv = config?.["api-key-env"] || DEFAULT_API_KEY_ENV;
  const baseUrl = config?.["base-url"] || DEFAULT_BASE_URL;
  const manager = new AccountManager(authDir, {
    provider: "deepseek",
    // API-key credentials do not expire or refresh. The far-future expiry on
    // the synthetic token keeps the manager's normal refresh loop inactive.
    refresh: async () => {
      throw new Error("DeepSeek API-key credentials do not support refresh");
    },
  });

  const apiKey = process.env[apiKeyEnv]?.trim();
  const storedTokens = loadAllTokens(authDir, "deepseek");
  if (apiKey && storedTokens.length === 0) {
    // Keep the secret in memory only. In particular, do not use addAccount,
    // which persists accessToken to auth-dir as an OAuth token file.
    manager.addEphemeralAccount(makeDeepSeekApiKeyToken(apiKey, apiKeyEnv));
  }

  return {
    id: "deepseek",
    nativeFormat: "anthropic-messages",
    manager,
    matchesModel: (model: string) => MODEL_RE.test(model),
    listModels: async () =>
      manager.accountCount > 0
        ? (advertisedModels ?? ADVERTISED_MODELS).map((id) => ({
            id,
            owned_by: "deepseek",
          }))
        : [],
    callMessages: (opts: UpstreamCallContext) =>
      callAnthropicMessagesWithApiKey({
        ...opts,
        baseUrl,
        normalizeToolResultMessages: true,
      }),
  };
}
