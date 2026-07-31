import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config";

test("loadConfig defaults credentials to the codex-providers directory", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-providers-config-"));
  const configPath = path.join(tempDir, "config.yaml");
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const config = loadConfig(configPath);

  assert.equal(config["auth-dir"], "~/.codex-providers");
});
