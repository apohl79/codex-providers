import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadAllTokens, saveToken } from "../src/auth/token-storage";
import {
  buildDeepSeekProvider,
  makeDeepSeekApiKeyToken,
} from "../src/providers/deepseek";

test("DeepSeek API-key credentials persist and reload from auth-dir", () => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-deepseek-"));
  try {
    const token = makeDeepSeekApiKeyToken(
      "deepseek-test-key",
      "DEEPSEEK_API_KEY",
    );
    saveToken(authDir, token);

    const files = fs.readdirSync(authDir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^deepseek-/);
    assert.equal(fs.statSync(path.join(authDir, files[0])).mode & 0o777, 0o600);

    const loaded = loadAllTokens(authDir, "deepseek");
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].accessToken, "deepseek-test-key");
    assert.equal(loaded[0].provider, "deepseek");

    const provider = buildDeepSeekProvider(authDir);
    provider.manager.load();
    assert.equal(provider.manager.accountCount, 1);
    const selected = provider.manager.getNextAccount();
    assert.equal(selected.account?.token.accessToken, "deepseek-test-key");
  } finally {
    fs.rmSync(authDir, { recursive: true, force: true });
  }
});
