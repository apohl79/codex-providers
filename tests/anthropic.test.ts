import assert from "node:assert/strict";
import test from "node:test";

import { buildAnthropicProvider } from "../src/providers/anthropic";

test("Anthropic model catalog advertises only canonical IDs", async () => {
  const models = await buildAnthropicProvider("").listModels();

  assert.deepEqual(models, [
    { id: "claude-opus-5", owned_by: "anthropic" },
    { id: "claude-opus-4-8", owned_by: "anthropic" },
    { id: "claude-fable-5", owned_by: "anthropic" },
    { id: "claude-sonnet-5", owned_by: "anthropic" },
    { id: "claude-haiku-4-5-20251001", owned_by: "anthropic" },
  ]);
});
