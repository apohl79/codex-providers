import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Request } from "express";

import { Config } from "../src/config";
import { saveToken } from "../src/auth/token-storage";
import {
  buildAnthropicProvider,
  makeAnthropicApiKeyToken,
} from "../src/providers/anthropic";

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

function loadApiKeyAccount(authDir: string) {
  saveToken(authDir, makeAnthropicApiKeyToken("anthropic-test-key"));
  const provider = buildAnthropicProvider(authDir);
  provider.manager.load();
  const selected = provider.manager.getNextAccount();
  if (!selected.account) throw new Error("Expected saved Anthropic API key");
  return { provider, account: selected.account };
}

test("Anthropic API-key accounts call Messages with direct authentication", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-anthropic-"));
  const { provider, account } = loadApiKeyAccount(authDir);
  const originalFetch = global.fetch;
  global.fetch = async (input, init) => {
    const headers = init?.headers as Record<string, string>;
    assert.equal(String(input), "https://api.anthropic.com/v1/messages");
    assert.equal(headers["x-api-key"], "anthropic-test-key");
    assert.equal(headers.Authorization, undefined);
    assert.equal(headers["anthropic-beta"], undefined);
    assert.deepEqual(JSON.parse(String(init?.body)).model, "claude-sonnet-5");
    return new Response("{}", { status: 200 });
  };
  t.after(() => {
    global.fetch = originalFetch;
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const response = await provider.callMessages({
    request: {
      body: { model: "sonnet", messages: [], max_tokens: 1 },
      headers: {},
    } as Request,
    account,
    config: makeConfig(authDir),
  });

  assert.equal(response.status, 200);
});

test("Anthropic API-key accounts send the thinking-binding beta when the body binds thinking blocks", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-anthropic-"));
  const { provider, account } = loadApiKeyAccount(authDir);
  const originalFetch = global.fetch;
  global.fetch = async (_input, init) => {
    const headers = init?.headers as Record<string, string>;
    assert.equal(
      headers["anthropic-beta"],
      "thinking-binding-controls-2026-08-01",
    );
    return new Response("{}", { status: 200 });
  };
  t.after(() => {
    global.fetch = originalFetch;
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const response = await provider.callMessages({
    request: {
      body: {
        model: "fable",
        messages: [],
        max_tokens: 1,
        thinking: {
          type: "adaptive",
          block_binding: { prefix_mismatch_behavior: "drop_block" },
        },
      },
      headers: {},
    } as Request,
    account,
    config: makeConfig(authDir),
  });

  assert.equal(response.status, 200);
});

test("Anthropic API-key accounts count tokens with direct authentication", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-anthropic-"));
  const { provider, account } = loadApiKeyAccount(authDir);
  const originalFetch = global.fetch;
  global.fetch = async (input, init) => {
    const headers = init?.headers as Record<string, string>;
    assert.equal(
      String(input),
      "https://api.anthropic.com/v1/messages/count_tokens",
    );
    assert.equal(headers["x-api-key"], "anthropic-test-key");
    assert.equal(headers.Authorization, undefined);
    assert.deepEqual(JSON.parse(String(init?.body)).model, "claude-sonnet-5");
    return new Response("{}", { status: 200 });
  };
  t.after(() => {
    global.fetch = originalFetch;
    fs.rmSync(authDir, { recursive: true, force: true });
  });
  const countTokens = provider.callCountTokens;
  assert.ok(countTokens);

  const response = await countTokens({
    request: {
      body: { model: "sonnet", messages: [] },
      headers: {},
    } as Request,
    account,
    config: makeConfig(authDir),
  });

  assert.equal(response.status, 200);
});
