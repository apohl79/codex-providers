import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadAllTokens, saveToken } from "../src/auth/token-storage";
import {
  buildGeminiProvider,
  makeGeminiApiKeyToken,
} from "../src/providers/gemini";
import {
  geminiToResponses,
  geminiSSEToResponses,
  makeGeminiResponsesState,
  responsesToGeminiGenerateContent,
} from "../src/upstream/gemini-translator";

const WEATHER_REQUEST = {
  model: "gemini-3.6-flash",
  instructions: "Use tools when needed.",
  input: [
    { role: "user", content: "Check Berlin weather" },
    {
      type: "function_call",
      call_id: "call_weather",
      name: "weather",
      arguments: '{"city":"Berlin"}',
    },
    {
      type: "function_call_output",
      call_id: "call_weather",
      output: "sunny",
    },
  ],
  tools: [
    {
      type: "function",
      name: "weather",
      description: "Returns weather.",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  ],
  tool_choice: { type: "function", function: { name: "weather" } },
  text: { format: { type: "json_object" } },
};

const NESTED_ADDITIONAL_PROPERTIES_REQUEST = {
  model: "gemini-3.6-flash",
  input: "Use a tool.",
  tools: [
    {
      type: "function",
      name: "configure",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          entries: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                settings: {
                  type: "object",
                  additionalProperties: false,
                  properties: { mode: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  ],
};

const IMAGE_REQUEST = {
  model: "gemini-3.6-flash",
  input: [
    {
      role: "user",
      content: [
        { type: "input_text", text: "Read these images." },
        { type: "input_image", image_url: "data:image/png;base64,YQ==" },
        {
          type: "input_image",
          image_url: { url: "data:image/jpeg;base64,Yg==" },
        },
        { type: "input_image", image_url: "https://example.test/image.png" },
      ],
    },
  ],
};

const EXPECTED_IMAGE_CONTENTS = [
  {
    role: "user",
    parts: [
      { text: "Read these images." },
      { inlineData: { mimeType: "image/png", data: "YQ==" } },
      { inlineData: { mimeType: "image/jpeg", data: "Yg==" } },
    ],
  },
];

const NATIVE_WEATHER_RESPONSE = {
  candidates: [
    {
      content: {
        parts: [
          { text: "Calling weather." },
          { functionCall: { name: "weather", args: { city: "Berlin" } } },
        ],
      },
      finishReason: "STOP",
    },
  ],
  usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 },
};

const EXPECTED_WEATHER_CONTENTS = [
  { role: "user", parts: [{ text: "Check Berlin weather" }] },
  {
    role: "model",
    parts: [{ functionCall: { name: "weather", args: { city: "Berlin" } } }],
  },
  {
    role: "user",
    parts: [
      {
        functionResponse: {
          name: "weather",
          response: { output: "sunny" },
        },
      },
    ],
  },
];

const EXPECTED_WEATHER_TOOLS = [
  {
    functionDeclarations: [
      {
        name: "weather",
        description: "Returns weather.",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ],
  },
];

const EXPECTED_NESTED_SCHEMA_TOOLS = [
  {
    functionDeclarations: [
      {
        name: "configure",
        description: "",
        parameters: {
          type: "object",
          properties: {
            entries: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  settings: {
                    type: "object",
                    properties: { mode: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
    ],
  },
];

test("Gemini API-key credentials persist and reload from auth-dir", () => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-gemini-"));
  try {
    saveToken(authDir, makeGeminiApiKeyToken("gemini-test-key"));

    const files = fs.readdirSync(authDir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^gemini-/);
    assert.equal(fs.statSync(path.join(authDir, files[0])).mode & 0o777, 0o600);

    const loaded = loadAllTokens(authDir, "gemini");
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].accessToken, "gemini-test-key");
    assert.equal(loaded[0].provider, "gemini");

    const provider = buildGeminiProvider(authDir);
    provider.manager.load();
    assert.equal(provider.manager.accountCount, 1);
    assert.equal(
      provider.manager.getNextAccount().account?.token.accessToken,
      "gemini-test-key",
    );
  } finally {
    fs.rmSync(authDir, { recursive: true, force: true });
  }
});

test("Gemini adapter translates Responses tools and function-call history", () => {
  const request = responsesToGeminiGenerateContent(WEATHER_REQUEST);

  assert.deepEqual(request.systemInstruction, {
    parts: [{ text: "Use tools when needed." }],
  });
  assert.deepEqual(request.contents, EXPECTED_WEATHER_CONTENTS);
  assert.deepEqual(request.tools, EXPECTED_WEATHER_TOOLS);
  assert.deepEqual(request.toolConfig, {
    functionCallingConfig: {
      mode: "ANY",
      allowedFunctionNames: ["weather"],
    },
  });
  assert.deepEqual(request.generationConfig, {
    responseMimeType: "application/json",
  });

  const response = geminiToResponses(
    NATIVE_WEATHER_RESPONSE,
    "gemini-3.6-flash",
  );

  assert.equal(response.status, "completed");
  assert.equal(response.output[0].content[0].text, "Calling weather.");
  assert.equal(response.output[1].type, "function_call");
  assert.equal(response.output[1].name, "weather");
  assert.equal(response.output[1].arguments, '{"city":"Berlin"}');
  assert.equal(response.usage.total_tokens, 10);
});

test("Gemini adapter removes unsupported additionalProperties from nested tool schemas", () => {
  const request = responsesToGeminiGenerateContent(
    NESTED_ADDITIONAL_PROPERTIES_REQUEST,
  );

  assert.deepEqual(request.tools, EXPECTED_NESTED_SCHEMA_TOOLS);
});

test("Gemini adapter translates Codex and OpenAI image inputs", () => {
  const request = responsesToGeminiGenerateContent(IMAGE_REQUEST);

  assert.deepEqual(request.contents, EXPECTED_IMAGE_CONTENTS);
});

test("Gemini streaming assigns a unique output index to each text and tool item", () => {
  const state = makeGeminiResponsesState();
  const events = geminiSSEToResponses(
    {
      candidates: [
        {
          content: {
            parts: [
              { text: "Calling tools." },
              { functionCall: { name: "first", args: {} } },
              { functionCall: { name: "second", args: {} } },
            ],
          },
        },
      ],
    },
    state,
    "gemini-3.6-flash",
  );
  const outputIndexes = events
    .map((event) => JSON.parse(event.split("\n")[1].slice(6)))
    .filter((event) => event.type === "response.output_item.added")
    .map((event) => event.output_index);

  assert.deepEqual(outputIndexes, [0, 1, 2]);
});
