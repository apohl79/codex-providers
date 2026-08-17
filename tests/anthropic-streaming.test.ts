import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { saveToken } from "../src/auth/token-storage";
import { Config } from "../src/config";
import { makeAnthropicApiKeyToken } from "../src/providers/anthropic";
import { buildRegistry } from "../src/providers/registry";
import { createServer } from "../src/server";

function makeConfig(authDir: string): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    "auth-dir": authDir,
    "api-keys": new Set(["test-key"]),
    "body-limit": "200mb",
    cloaking: {},
    timeouts: {
      "messages-ms": 120000,
      "stream-messages-ms": 600000,
      "count-tokens-ms": 30000,
    },
    stats: { enabled: false },
    debug: "off",
  };
}

async function startServer(authDir: string): Promise<http.Server> {
  saveToken(authDir, makeAnthropicApiKeyToken("anthropic-test-key"));
  const registry = buildRegistry(authDir);
  registry.all().forEach((provider) => provider.manager.load());
  const server = http.createServer(createServer(makeConfig(authDir), registry));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

async function stopServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function serverPort(server: http.Server): number {
  const address = server.address() as AddressInfo;
  return address.port;
}

async function requestStream(
  server: http.Server,
): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify({
    model: "claude-opus-5",
    input: [{ role: "user", content: "Review this change" }],
    reasoning: { effort: "medium", summary: "auto" },
    stream: true,
  });
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: serverPort(server),
        method: "POST",
        path: "/v1/responses",
        headers: {
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode || 0, body }),
        );
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

function truncatedAnthropicStream(): string {
  return [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_truncated","type":"message","role":"assistant","content":[],"stop_reason":null,"usage":{"input_tokens":69360,"output_tokens":1}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_omitted"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens","stop_sequence":null},"usage":{"input_tokens":69360,"output_tokens":8192,"cache_read_input_tokens":7857}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join("");
}

test("preserves omitted reasoning when Anthropic truncates the stream", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-stream-"));
  const originalFetch = global.fetch;
  global.fetch = async (input, init) => {
    assert.equal(String(input), "https://api.anthropic.com/v1/messages");
    assert.equal(
      (init?.headers as Record<string, string>)["x-api-key"],
      "anthropic-test-key",
    );
    const body = JSON.parse(String(init?.body)) as {
      max_tokens: number;
      stream: boolean;
      thinking: { type: string; display: string };
      output_config: { effort: string };
    };
    assert.deepEqual(
      {
        maxTokens: body.max_tokens,
        stream: body.stream,
        thinking: body.thinking,
        outputConfig: body.output_config,
      },
      {
        maxTokens: 65536,
        stream: true,
        thinking: { type: "adaptive", display: "summarized" },
        outputConfig: { effort: "medium" },
      },
    );
    return new Response(truncatedAnthropicStream(), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  const server = await startServer(authDir);
  t.after(async () => {
    global.fetch = originalFetch;
    await stopServer(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const response = await requestStream(server);

  assert.equal(response.status, 200);
  assert.match(response.body, /"encrypted_content":"sig_omitted"/);
  assert.match(response.body, /event: response\.incomplete/);
  assert.match(
    response.body,
    /"incomplete_details":\{"reason":"max_output_tokens"\}/,
  );
  assert.doesNotMatch(response.body, /event: response\.completed/);
  assert.match(response.body, /"output_tokens":8192/);
});
