import { ProviderId } from "../auth/types";

const FERNET_MIN_RAW_BYTES = 57;
const FERNET_VERSION = 0x80;
const FERNET_CIPHERTEXT_BLOCK_BYTES = 16;
const FERNET_PREFIX = "gAAAA";
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/;
const INTER_AGENT_TOOL_NAMES = new Set([
  "spawn_agent",
  "send_message",
  "followup_task",
]);

export class ProviderConsistencyError extends Error {
  readonly type = "provider_consistency_error";
  readonly status = 400;
  readonly provider = "codex";
  readonly code = "plaintext_inter_agent_encrypted_content";

  constructor() {
    super(
      "Mixed-provider Codex inter-agent delivery is unsupported: plaintext encrypted_content cannot be forwarded to the codex provider. Run parent and child agents on the same provider, or use a codex parent so the ChatGPT backend seals the message.",
    );
  }
}

export type ProviderConsistencyErrorBody = Readonly<{
  error: Readonly<{
    message: string;
    type: ProviderConsistencyError["type"];
    code: ProviderConsistencyError["code"];
    provider: ProviderConsistencyError["provider"];
  }>;
}>;

export type InterAgentContentDeliveryContext = Readonly<{
  targetProvider: ProviderId;
}>;

export function providerConsistencyErrorBody(
  error: ProviderConsistencyError,
): ProviderConsistencyErrorBody {
  return Object.freeze({
    error: Object.freeze({
      message: error.message,
      type: error.type,
      code: error.code,
      provider: error.provider,
    }),
  });
}

export function providerConsistencyErrorForInterAgentContent(
  body: unknown,
  ctx: InterAgentContentDeliveryContext,
): ProviderConsistencyError | null {
  return ctx.targetProvider === "codex" && hasPlaintextInterAgentContent(body)
    ? new ProviderConsistencyError()
    : null;
}

export function isFernetToken(value: string): boolean {
  const decoded = decodeBase64Url(value);
  return (
    value.startsWith(FERNET_PREFIX) &&
    decoded !== null &&
    decoded.length >= FERNET_MIN_RAW_BYTES &&
    decoded[0] === FERNET_VERSION &&
    (decoded.length - FERNET_MIN_RAW_BYTES) % FERNET_CIPHERTEXT_BLOCK_BYTES ===
      0
  );
}

function hasPlaintextInterAgentContent(body: unknown): boolean {
  return inputItems(body).some(
    (item) =>
      isPlaintextAgentMessage(item) || isPlaintextInterAgentToolCall(item),
  );
}

function inputItems(body: unknown): Record<string, unknown>[] {
  const input = readObject(body)?.input;
  return Array.isArray(input) ? input.filter(isRecord) : [];
}

function isPlaintextAgentMessage(item: Record<string, unknown>): boolean {
  return item.type === "agent_message" && hasPlaintextEncryptedContent(item);
}

function isPlaintextInterAgentToolCall(item: Record<string, unknown>): boolean {
  const name = typeof item.name === "string" ? item.name : "";
  return (
    item.type === "function_call" &&
    INTER_AGENT_TOOL_NAMES.has(name) &&
    toolCallMessage(item.arguments) !== null &&
    !isFernetToken(toolCallMessage(item.arguments) ?? "")
  );
}

function hasPlaintextEncryptedContent(value: unknown): boolean {
  return encryptedContentValues(value).some(
    (content) => !isFernetToken(content),
  );
}

function encryptedContentValues(value: unknown): string[] {
  const record = readObject(value);
  return Array.isArray(value)
    ? value.flatMap(encryptedContentValues)
    : record === null
      ? []
      : [
          ...(typeof record.encrypted_content === "string"
            ? [record.encrypted_content]
            : []),
          ...Object.values(record).flatMap(encryptedContentValues),
        ];
}

function toolCallMessage(argumentsValue: unknown): string | null {
  const parsed =
    typeof argumentsValue === "string"
      ? parseJsonObject(argumentsValue)
      : readObject(argumentsValue);
  return typeof parsed?.message === "string" ? parsed.message : null;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    return readObject(JSON.parse(value));
  } catch {
    return null;
  }
}

function readObject(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBase64Url(value: string): Buffer | null {
  return BASE64URL_PATTERN.test(value)
    ? Buffer.from(
        value
          .replace(/-/g, "+")
          .replace(/_/g, "/")
          .padEnd(value.length + ((4 - (value.length % 4)) % 4), "="),
        "base64",
      )
    : null;
}
