import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";

import { Config } from "../src/config";
import { createServer as createAuth2ApiServer } from "../src/server";
import { saveToken } from "../src/auth/token-storage";
import { TokenData } from "../src/auth/types";
import { buildRegistry } from "../src/providers/registry";
import { ProviderRegistry } from "../src/providers/registry";
import {
  isFernetToken,
  providerConsistencyErrorBody,
  providerConsistencyErrorForInterAgentContent,
  ProviderConsistencyError,
} from "../src/upstream/inter-agent-content-guard";

const providerConsistencyMessage =
  "Mixed-provider Codex inter-agent delivery is unsupported: plaintext encrypted_content cannot be forwarded to the codex provider. Run parent and child agents on the same provider, or use a codex parent so the ChatGPT backend seals the message.";

function makeConfig(authDir: string): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    "auth-dir": authDir,
    "api-keys": new Set(["test-key"]),
    "body-limit": "200mb",
    cloaking: { "cli-version": "2.1.88", entrypoint: "cli" },
    timeouts: {
      "messages-ms": 120000,
      "stream-messages-ms": 600000,
      "count-tokens-ms": 30000,
    },
    debug: "off",
  };
}

function makeCodexToken(): TokenData {
  return {
    accessToken: "codex-access",
    refreshToken: "codex-refresh",
    email: "codex@example.com",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    accountUuid: "chatgpt-account-id",
    provider: "codex",
  };
}

function structurallyValidFernetToken(): string {
  return Buffer.concat([
    Buffer.from([0x80]),
    Buffer.alloc(8),
    Buffer.alloc(16),
    Buffer.alloc(16),
    Buffer.alloc(32),
  ]).toString("base64url");
}

function serverAddress(server: http.Server): AddressInfo {
  return server.address() as AddressInfo;
}

function startServer(
  config: Config,
  registry: ProviderRegistry,
): Promise<http.Server> {
  const server = http.createServer(createAuth2ApiServer(config, registry));
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server)),
  );
}

function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function requestJson(options: {
  server: http.Server;
  method: string;
  urlPath: string;
  body: unknown;
}): Promise<{ status: number; body: unknown }> {
  const payload = JSON.stringify(options.body);
  const address = serverAddress(options.server);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: address.port,
        path: options.urlPath,
        method: options.method,
        headers: {
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload).toString(),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

function withMockedFetch(handler: typeof fetch): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

test("isFernetToken accepts structurally valid Fernet tokens", () => {
  assert.equal(isFernetToken(structurallyValidFernetToken()), true);
});

test("isFernetToken rejects plaintext and malformed tokens", () => {
  assert.equal(isFernetToken("search for the weather"), false);
  assert.equal(isFernetToken("gAAAA"), false);
});

test("providerConsistencyErrorForInterAgentContent rejects plaintext codex agent messages", () => {
  const error = providerConsistencyErrorForInterAgentContent(
    {
      input: [
        {
          type: "agent_message",
          author: "/root",
          recipient: "/root/child",
          content: [
            {
              type: "encrypted_content",
              encrypted_content: "search for the weather",
            },
          ],
        },
      ],
    },
    { targetProvider: "codex" },
  );

  assert.ok(error instanceof ProviderConsistencyError);
  assert.deepEqual(providerConsistencyErrorBody(error), {
    error: {
      message: providerConsistencyMessage,
      type: "provider_consistency_error",
      code: "plaintext_inter_agent_encrypted_content",
      provider: "codex",
    },
  });
});

test("providerConsistencyErrorForInterAgentContent allows Fernet codex agent messages", () => {
  assert.equal(
    providerConsistencyErrorForInterAgentContent(
      {
        input: [
          {
            type: "agent_message",
            content: [
              {
                type: "encrypted_content",
                encrypted_content: structurallyValidFernetToken(),
              },
            ],
          },
        ],
      },
      { targetProvider: "codex" },
    ),
    null,
  );
});

test("providerConsistencyErrorForInterAgentContent allows non-codex plaintext agent messages", () => {
  assert.equal(
    providerConsistencyErrorForInterAgentContent(
      {
        input: [
          {
            type: "agent_message",
            content: [
              {
                type: "encrypted_content",
                encrypted_content: "search for the weather",
              },
            ],
          },
        ],
      },
      { targetProvider: "anthropic" },
    ),
    null,
  );
});

test("providerConsistencyErrorForInterAgentContent rejects plaintext inter-agent tool calls", () => {
  const error = providerConsistencyErrorForInterAgentContent(
    {
      input: [
        {
          type: "function_call",
          name: "spawn_agent",
          arguments: JSON.stringify({
            agent_type: "general-purpose-gpt",
            task_name: "probe",
            message: "search for the weather",
          }),
        },
      ],
    },
    { targetProvider: "codex" },
  );

  assert.equal(error?.type, "provider_consistency_error");
});

test("codex responses rejects plaintext inter-agent content before upstream fetch", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-guard-"));
  saveToken(authDir, makeCodexToken());
  const registry = buildRegistry(authDir);
  registry.all().forEach((provider) => provider.manager.load());
  const server = await startServer(makeConfig(authDir), registry);
  let upstreamCalled = false;
  const restoreFetch = withMockedFetch(async () => {
    upstreamCalled = true;
    return new Response("unexpected upstream call", { status: 500 });
  });
  t.after(async () => {
    restoreFetch();
    await stopServer(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const response = await requestJson({
    server,
    method: "POST",
    urlPath: "/v1/responses",
    body: {
      model: "gpt-5.5",
      input: [
        {
          type: "agent_message",
          author: "/root",
          recipient: "/root/capture_probe",
          content: [
            {
              type: "encrypted_content",
              encrypted_content: "search for the weather",
            },
          ],
        },
      ],
      stream: false,
    },
  });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, {
    error: {
      message: providerConsistencyMessage,
      type: "provider_consistency_error",
      code: "plaintext_inter_agent_encrypted_content",
      provider: "codex",
    },
  });
  assert.equal(upstreamCalled, false);
});
