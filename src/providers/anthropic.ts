import { PKCECodes, TokenData } from "../auth/types";
import { loadAllTokens } from "../auth/token-storage";
import {
  generateAuthURL,
  exchangeCodeForTokens,
  refreshTokensWithRetry,
} from "../auth/oauth";
import { AccountManager } from "../accounts/manager";
import {
  callAnthropicMessages,
  callAnthropicMessagesWithApiKey,
  callAnthropicCountTokens,
  callAnthropicCountTokensWithApiKey,
} from "../upstream/anthropic-api";
import { applyCloaking } from "../upstream/cloaking";
import {
  Provider,
  UpstreamCallContext,
  CloakingContext,
  ProviderOAuthInfo,
} from "./types";

const ANTHROPIC_OAUTH: ProviderOAuthInfo = {
  callbackPort: 54545,
  callbackPath: "/callback",
};

const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";
const ANTHROPIC_API_KEY_ACCOUNT_UUID = "anthropic-api-key";
const ANTHROPIC_API_BASE_URL = "https://api.anthropic.com";
const MODEL_RE = /^claude-/i;

const ADVERTISED_MODELS = [
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-fable-5",
  "claude-sonnet-5",
  "claude-haiku-4-5-20251001",
];

export function makeAnthropicApiKeyToken(
  apiKey: string,
  apiKeyEnv: string = ANTHROPIC_API_KEY_ENV,
): TokenData {
  return {
    accessToken: apiKey,
    refreshToken: "",
    email: `anthropic-api-key@${apiKeyEnv.toLowerCase()}`,
    expiresAt: "9999-12-31T23:59:59.999Z",
    accountUuid: ANTHROPIC_API_KEY_ACCOUNT_UUID,
    provider: "anthropic",
  };
}

export function isAnthropicApiKeyToken(token: TokenData): boolean {
  return token.accountUuid === ANTHROPIC_API_KEY_ACCOUNT_UUID;
}

export function buildAnthropicProvider(
  authDir: string,
  advertisedModels: string[] | undefined = undefined,
): Provider {
  const manager = new AccountManager(authDir, {
    provider: "anthropic",
    refresh: async (rt: string): Promise<TokenData> => {
      const token = await refreshTokensWithRetry(rt);
      return { ...token, provider: "anthropic" };
    },
  });
  const apiKey = process.env[ANTHROPIC_API_KEY_ENV]?.trim();
  const storedTokens = loadAllTokens(authDir, "anthropic");
  if (apiKey && !storedTokens.some(isAnthropicApiKeyToken)) {
    manager.addEphemeralAccount(makeAnthropicApiKeyToken(apiKey));
  }

  return {
    id: "anthropic",
    nativeFormat: "anthropic-messages",
    manager,
    oauth: ANTHROPIC_OAUTH,
    matchesModel: (model: string) => MODEL_RE.test(model),
    buildAuthUrl: (state: string, pkce: PKCECodes) =>
      generateAuthURL(state, pkce),
    exchangeCode: async (code, returnedState, expectedState, pkce) => {
      const token = await exchangeCodeForTokens(
        code,
        returnedState,
        expectedState,
        pkce,
      );
      return { ...token, provider: "anthropic" };
    },
    listModels: async () =>
      (advertisedModels ?? ADVERTISED_MODELS).map((id) => ({
        id,
        owned_by: "anthropic",
      })),
    callMessages: (opts: UpstreamCallContext) =>
      isAnthropicApiKeyToken(opts.account.token)
        ? callAnthropicMessagesWithApiKey({
            ...opts,
            baseUrl: ANTHROPIC_API_BASE_URL,
            resolveModelId: true,
            includeBetaHeaders: true,
          })
        : callAnthropicMessages(opts),
    callCountTokens: (opts: UpstreamCallContext) =>
      isAnthropicApiKeyToken(opts.account.token)
        ? callAnthropicCountTokensWithApiKey({
            request: opts.request,
            account: opts.account,
            config: opts.config,
            signal: opts.signal,
            baseUrl: ANTHROPIC_API_BASE_URL,
          })
        : callAnthropicCountTokens({
            request: opts.request,
            account: opts.account,
            config: opts.config,
            signal: opts.signal,
          }),
    applyCloaking: (opts: CloakingContext) => applyCloaking(opts),
  };
}
