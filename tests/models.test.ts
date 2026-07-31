import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { saveToken } from "../src/auth/token-storage";
import { ProviderId, TokenData } from "../src/auth/types";
import { Config, loadConfig, ModelAdvertisementsConfig } from "../src/config";
import { buildRegistry } from "../src/providers/registry";
import { createServer } from "../src/server";

type ModelsResponse = {
  object: string;
  data: Array<{
    id: string;
    object: string;
    created: number;
    owned_by: string;
  }>;
};

type ModelsRequestResult = {
  status: number;
  body: ModelsResponse | { error: { message: string } };
};

function makeConfig(authDir: string): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    "auth-dir": authDir,
    "api-keys": new Set(["test-key"]),
    "body-limit": "200mb",
    cloaking: {
      "cli-version": "2.1.88",
      entrypoint: "cli",
    },
    timeouts: {
      "messages-ms": 120000,
      "stream-messages-ms": 600000,
      "count-tokens-ms": 30000,
    },
    debug: "off",
  };
}

function makeToken(provider: ProviderId): TokenData {
  return {
    accessToken: `${provider}-access-token`,
    refreshToken: `${provider}-refresh-token`,
    email: `${provider}@example.com`,
    expiresAt: "2099-01-01T00:00:00.000Z",
    accountUuid: `${provider}-account`,
    provider,
  };
}

async function startProviderCatalogServer(
  modelAdvertisements?: ModelAdvertisementsConfig,
): Promise<{
  authDir: string;
  server: ReturnType<typeof createHttpServer>;
}> {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-models-"));
  saveToken(authDir, makeToken("anthropic"));
  saveToken(authDir, makeToken("deepseek"));
  saveToken(authDir, makeToken("google"));
  const registry = buildRegistry(
    authDir,
    undefined,
    undefined,
    modelAdvertisements,
  );
  registry.all().forEach((provider) => provider.manager.load());
  const server = createHttpServer(createServer(makeConfig(authDir), registry));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { authDir, server };
}

function serverUrl(
  server: ReturnType<typeof createHttpServer>,
  pathName: string,
): string {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server is not listening on a TCP port");
  }
  return `http://127.0.0.1:${(address as AddressInfo).port}${pathName}`;
}

async function requestModels(
  server: ReturnType<typeof createHttpServer>,
  pathName: string,
): Promise<ModelsRequestResult> {
  const response = await fetch(serverUrl(server, pathName), {
    headers: { Authorization: "Bearer test-key" },
  });
  return {
    status: response.status,
    body: (await response.json()) as ModelsRequestResult["body"],
  };
}

async function stopProviderCatalogServer(
  server: ReturnType<typeof createHttpServer>,
  authDir: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  fs.rmSync(authDir, { recursive: true, force: true });
}

test("filters models by provider", async (t) => {
  const { authDir, server } = await startProviderCatalogServer();
  t.after(() => stopProviderCatalogServer(server, authDir));

  const result = await requestModels(server, "/v1/models?provider=deepseek");

  assert.deepEqual(
    {
      status: result.status,
      object: (result.body as ModelsResponse).object,
      models: (result.body as ModelsResponse).data.map(({ id, owned_by }) => ({
        id,
        owned_by,
      })),
    },
    {
      status: 200,
      object: "list",
      models: [
        { id: "deepseek-v4-pro", owned_by: "deepseek" },
        { id: "deepseek-v4-flash", owned_by: "deepseek" },
      ],
    },
  );
});

test("returns an empty catalog for providers without an account", async (t) => {
  const { authDir, server } = await startProviderCatalogServer();
  t.after(() => stopProviderCatalogServer(server, authDir));

  const result = await requestModels(server, "/v1/models?provider=codex");

  assert.deepEqual(
    {
      status: result.status,
      object: (result.body as ModelsResponse).object,
      models: (result.body as ModelsResponse).data,
    },
    { status: 200, object: "list", models: [] },
  );
});

test("filters Gemini models by provider", async (t) => {
  const { authDir, server } = await startProviderCatalogServer();
  t.after(() => stopProviderCatalogServer(server, authDir));

  const result = await requestModels(server, "/v1/models?provider=google");

  assert.deepEqual(
    {
      status: result.status,
      object: (result.body as ModelsResponse).object,
      models: (result.body as ModelsResponse).data.map(({ id, owned_by }) => ({
        id,
        owned_by,
      })),
    },
    {
      status: 200,
      object: "list",
      models: [
        { id: "gemini-3.6-flash", owned_by: "google" },
        { id: "gemini-3.5-flash", owned_by: "google" },
        { id: "gemini-3.1-pro-preview", owned_by: "google" },
        { id: "gemini-3-pro-preview", owned_by: "google" },
      ],
    },
  );
});

test("serves more than sixty authenticated model catalog requests", async (t) => {
  const { authDir, server } = await startProviderCatalogServer();
  t.after(() => stopProviderCatalogServer(server, authDir));

  const results = await Promise.all(
    Array.from({ length: 61 }, () =>
      requestModels(server, "/v1/models?provider=google"),
    ),
  );

  assert.deepEqual(
    results.map((result) => result.status),
    Array.from({ length: 61 }, () => 200),
  );
});

test("advertises only the selected models for each managed provider", async (t) => {
  const { authDir, server } = await startProviderCatalogServer({
    anthropic: ["claude-sonnet-5"],
    deepseek: ["deepseek-v4-flash"],
    google: ["gemini-3.5-flash"],
  });
  t.after(() => stopProviderCatalogServer(server, authDir));

  const results = await Promise.all(
    ["anthropic", "deepseek", "google"].map((provider) =>
      requestModels(server, `/v1/models?provider=${provider}`),
    ),
  );

  assert.deepEqual(
    results.map((result) => ({
      status: result.status,
      models: (result.body as ModelsResponse).data.map(({ id, owned_by }) => ({
        id,
        owned_by,
      })),
    })),
    [
      {
        status: 200,
        models: [{ id: "claude-sonnet-5", owned_by: "anthropic" }],
      },
      {
        status: 200,
        models: [{ id: "deepseek-v4-flash", owned_by: "deepseek" }],
      },
      {
        status: 200,
        models: [{ id: "gemini-3.5-flash", owned_by: "google" }],
      },
    ],
  );
});

test("loads configured model advertisements", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-config-"));
  const configPath = path.join(directory, "config.yaml");
  try {
    fs.writeFileSync(
      configPath,
      "api-keys: [test-key]\nmodel-advertisements:\n  anthropic: [claude-sonnet-5]\n  deepseek: [deepseek-v4-flash]\n  google: [gemini-3.5-flash]\n",
    );

    assert.deepEqual(loadConfig(configPath)["model-advertisements"], {
      anthropic: ["claude-sonnet-5"],
      deepseek: ["deepseek-v4-flash"],
      google: ["gemini-3.5-flash"],
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects invalid provider model filters", async (t) => {
  const { authDir, server } = await startProviderCatalogServer();
  t.after(() => stopProviderCatalogServer(server, authDir));

  const results = await Promise.all(
    ["unknown", "gemini", "anthropic&provider=deepseek"].map((provider) =>
      requestModels(server, `/v1/models?provider=${provider}`),
    ),
  );

  assert.deepEqual(results, [
    { status: 400, body: { error: { message: "Invalid provider filter" } } },
    { status: 400, body: { error: { message: "Invalid provider filter" } } },
    { status: 400, body: { error: { message: "Invalid provider filter" } } },
  ]);
});
