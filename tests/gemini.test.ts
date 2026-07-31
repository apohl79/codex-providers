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
  completeGeminiResponses,
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

const NATIVE_THOUGHT_SIGNATURE_RESPONSE = {
  candidates: [
    {
      content: {
        parts: [
          {
            functionCall: { name: "exec_command", args: { cmd: "pwd" } },
            thoughtSignature: "opaque-thought-signature",
          },
        ],
      },
      finishReason: "STOP",
    },
  ],
};

const NATIVE_PROMPT_BLOCKED_RESPONSE = {
  promptFeedback: { blockReason: "PROHIBITED_CONTENT" },
  usageMetadata: { promptTokenCount: 21_577, candidatesTokenCount: 0 },
};

const NATIVE_MALFORMED_FUNCTION_CALL_RESPONSE = {
  candidates: [
    {
      content: { parts: [] },
      finishReason: "MALFORMED_FUNCTION_CALL",
      finishMessage: "Function arguments were invalid.",
    },
  ],
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

const LEGACY_GEMINI_TOKEN = JSON.stringify({
  access_token: "legacy-gemini-key",
  refresh_token: "",
  last_refresh: "2026-01-01T00:00:00.000Z",
  email: "legacy@example.com",
  type: "gemini",
  expired: "9999-12-31T23:59:59.999Z",
  account_uuid: "gemini-api-key",
});

test("Gemini API-key credentials persist and reload from auth-dir", () => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-gemini-"));
  try {
    saveToken(authDir, makeGeminiApiKeyToken("gemini-test-key"));

    const files = fs.readdirSync(authDir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^google-/);
    assert.equal(fs.statSync(path.join(authDir, files[0])).mode & 0o777, 0o600);

    const loaded = loadAllTokens(authDir, "google");
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].accessToken, "gemini-test-key");
    assert.equal(loaded[0].provider, "google");

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

test("Google provider loads legacy Gemini API-key credentials", () => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-gemini-"));
  try {
    fs.writeFileSync(
      path.join(authDir, "gemini-legacy@example.com.json"),
      LEGACY_GEMINI_TOKEN,
      { mode: 0o600 },
    );

    assert.deepEqual(
      loadAllTokens(authDir, "google").map(({ accessToken, provider }) => ({
        accessToken,
        provider,
      })),
      [{ accessToken: "legacy-gemini-key", provider: "google" }],
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

test("Gemini adapter restores thought signatures for replayed function calls", () => {
  const response = geminiToResponses(
    NATIVE_THOUGHT_SIGNATURE_RESPONSE,
    "gemini-3.6-flash",
  );
  const functionCall = response.output[0];
  const request = responsesToGeminiGenerateContent({
    model: "gemini-3.6-flash",
    input: [
      { role: "user", content: "Show the working directory." },
      {
        type: "function_call",
        call_id: functionCall.call_id,
        name: functionCall.name,
        arguments: functionCall.arguments,
      },
      {
        type: "function_call_output",
        call_id: functionCall.call_id,
        output: "/workspace",
      },
    ],
  });

  assert.deepEqual(functionCall.extra_content, {
    google: { thought_signature: "opaque-thought-signature" },
  });
  assert.equal(functionCall.thought_signature, "opaque-thought-signature");
  assert.deepEqual(request.contents, [
    { role: "user", parts: [{ text: "Show the working directory." }] },
    {
      role: "model",
      parts: [
        {
          functionCall: { name: "exec_command", args: { cmd: "pwd" } },
          thoughtSignature: "opaque-thought-signature",
        },
      ],
    },
    {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: "exec_command",
            response: { output: "/workspace" },
          },
        },
      ],
    },
  ]);
});

test("Gemini adapter fails no-candidate responses with prompt feedback", () => {
  const response = geminiToResponses(
    NATIVE_PROMPT_BLOCKED_RESPONSE,
    "gemini-3.1-pro-preview",
  );

  assert.equal(response.status, "failed");
  assert.deepEqual(response.output, []);
  assert.deepEqual(response.error, {
    type: "upstream_error",
    message: "Gemini blocked the prompt: PROHIBITED_CONTENT.",
  });
  assert.equal(response.usage.input_tokens, 21_577);
  assert.equal(response.usage.output_tokens, 0);
});

test("Gemini adapter includes candidate termination details for empty output", () => {
  const response = geminiToResponses(
    NATIVE_MALFORMED_FUNCTION_CALL_RESPONSE,
    "gemini-3.1-pro-preview",
  );

  assert.equal(response.status, "failed");
  assert.deepEqual(response.error, {
    type: "upstream_error",
    message:
      "Gemini returned no visible output: MALFORMED_FUNCTION_CALL (Function arguments were invalid.).",
  });
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

test("Gemini streaming fails no-candidate responses with prompt feedback", () => {
  const state = makeGeminiResponsesState();
  const events = [
    ...geminiSSEToResponses(
      NATIVE_PROMPT_BLOCKED_RESPONSE,
      state,
      "gemini-3.1-pro-preview",
    ),
    ...completeGeminiResponses(state, "gemini-3.1-pro-preview", {
      inputTokens: 21_577,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      reasoningOutputTokens: 0,
    }),
  ].map((event) => JSON.parse(event.split("\n")[1].slice(6)));

  const failure = events.find((event) => event.type === "response.failed");

  assert.equal(
    events.some((event) => event.type === "response.completed"),
    false,
  );
  assert.deepEqual(failure.response.error, {
    type: "upstream_error",
    message: "Gemini blocked the prompt: PROHIBITED_CONTENT.",
  });
});
