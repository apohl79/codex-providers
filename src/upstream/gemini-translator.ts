import { v4 as uuidv4 } from "uuid";
import { UsageData } from "../accounts/manager";

const CUSTOM_TOOL_NAME = "apply_patch";

function compactUuid(): string {
  return uuidv4().replace(/-/g, "");
}

function outputText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) =>
      part?.type === "input_text" ||
      part?.type === "output_text" ||
      part?.type === "text"
        ? part.text || ""
        : "",
    )
    .join("");
}

function inlineDataPart(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^data:([^;,]+);base64,(.+)$/);
  return match ? { inlineData: { mimeType: match[1], data: match[2] } } : null;
}

function contentParts(content: unknown): Record<string, unknown>[] {
  if (typeof content === "string") return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part: any) => {
    if (typeof part === "string") return part ? [{ text: part }] : [];
    if (
      part?.type === "input_text" ||
      part?.type === "output_text" ||
      part?.type === "text"
    ) {
      return typeof part.text === "string" && part.text
        ? [{ text: part.text }]
        : [];
    }
    if (part?.type === "input_image" || part?.type === "image") {
      const imageUrl = part.image_url?.url || part.url;
      const imagePart = inlineDataPart(imageUrl);
      return imagePart ? [imagePart] : [];
    }
    return [];
  });
}

function responseInputItems(body: any): any[] {
  if (Array.isArray(body.input)) return body.input;
  if (typeof body.input === "string") {
    return [{ role: "user", content: body.input }];
  }
  if (Array.isArray(body.messages)) return body.messages;
  return [];
}

function responseToolParts(item: any): Record<string, unknown>[] {
  if (item.type === "function_call" || item.type === "custom_tool_call") {
    const argumentsValue =
      item.type === "custom_tool_call"
        ? { input: item.input || "" }
        : item.arguments;
    let args: Record<string, unknown> = {};
    try {
      args =
        typeof argumentsValue === "string"
          ? JSON.parse(argumentsValue)
          : argumentsValue || {};
    } catch {
      args = {};
    }
    return [
      {
        functionCall: {
          name: item.name || "tool",
          args,
        },
      },
    ];
  }
  return [];
}

function functionResponsePart(
  item: any,
  functionNames: Map<string, string>,
): Record<string, unknown> {
  const output =
    typeof item.output === "string" ? item.output : JSON.stringify(item.output);
  const name = functionNames.get(item.call_id) || "tool";
  return {
    functionResponse: {
      name,
      response: { output },
    },
  };
}

function appendContent(
  contents: Record<string, unknown>[],
  role: "user" | "model",
  parts: Record<string, unknown>[],
): void {
  if (parts.length === 0) return;
  const previous = contents[contents.length - 1];
  if (previous?.role === role && Array.isArray(previous.parts)) {
    previous.parts.push(...parts);
    return;
  }
  contents.push({ role, parts });
}

function toolDeclarations(tools: any): Record<string, unknown>[] {
  if (!Array.isArray(tools)) return [];
  const declarations = tools.flatMap((tool: any) => {
    if (tool?.type === "function" && tool.name) {
      return [
        {
          name: tool.name,
          description: tool.description || "",
          parameters: tool.parameters ||
            tool.input_schema || { type: "object", properties: {} },
        },
      ];
    }
    if (tool?.type === "custom" && tool.name === CUSTOM_TOOL_NAME) {
      return [
        {
          name: tool.name,
          description: tool.description || "",
          parameters: {
            type: "object",
            properties: { input: { type: "string" } },
            required: ["input"],
            additionalProperties: false,
          },
        },
      ];
    }
    return [];
  });
  return declarations.length ? [{ functionDeclarations: declarations }] : [];
}

function toolConfig(toolChoice: any): Record<string, unknown> | null {
  if (toolChoice === "none") {
    return { functionCallingConfig: { mode: "NONE" } };
  }
  if (toolChoice === "required") {
    return { functionCallingConfig: { mode: "ANY" } };
  }
  if (toolChoice?.type === "function" && toolChoice?.function?.name) {
    return {
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: [toolChoice.function.name],
      },
    };
  }
  return null;
}

function generationConfig(body: any): Record<string, unknown> | null {
  const config: Record<string, unknown> = {};
  if (body.temperature !== undefined) config.temperature = body.temperature;
  if (body.top_p !== undefined) config.topP = body.top_p;
  if (body.max_output_tokens !== undefined) {
    config.maxOutputTokens = body.max_output_tokens;
  }
  if (body.text?.format?.type === "json_object") {
    config.responseMimeType = "application/json";
  }
  if (body.text?.format?.type === "json_schema" && body.text.format.schema) {
    config.responseMimeType = "application/json";
    config.responseJsonSchema = body.text.format.schema;
  }
  return Object.keys(config).length ? config : null;
}

function thinkingConfig(body: any): Record<string, unknown> | null {
  const effort = body.reasoning?.effort;
  const level =
    effort === "minimal" || effort === "low"
      ? "LOW"
      : effort === "medium"
        ? "MEDIUM"
        : effort === "high" || effort === "xhigh" || effort === "max"
          ? "HIGH"
          : "";
  return level ? { thinkingLevel: level } : null;
}

export function responsesToGeminiGenerateContent(body: any): any {
  const contents: Record<string, unknown>[] = [];
  const functionNames = new Map<string, string>();
  const systemTexts = [
    typeof body.instructions === "string" ? body.instructions : "",
  ];

  for (const item of responseInputItems(body)) {
    if (item?.role === "system" || item?.role === "developer") {
      const text = outputText(item.content);
      if (text) systemTexts.push(text);
      continue;
    }
    if (
      item?.type === "function_call_output" ||
      item?.type === "custom_tool_call_output"
    ) {
      appendContent(contents, "user", [
        functionResponsePart(item, functionNames),
      ]);
      continue;
    }
    if (item?.type === "function_call" || item?.type === "custom_tool_call") {
      const parts = responseToolParts(item);
      const callId = item.call_id || item.id;
      if (callId && item.name) functionNames.set(callId, item.name);
      appendContent(contents, "model", parts);
      continue;
    }
    if (item?.type === "agent_message") {
      appendContent(contents, "model", contentParts(item.content));
      continue;
    }
    const role =
      item?.role === "assistant" || item?.role === "model" ? "model" : "user";
    appendContent(contents, role, contentParts(item?.content));
  }

  const request: Record<string, unknown> = {
    model: body.model,
    stream: !!body.stream,
    contents,
  };
  const instruction = systemTexts.filter(Boolean).join("\n\n");
  if (instruction)
    request.systemInstruction = { parts: [{ text: instruction }] };
  const tools = toolDeclarations(body.tools);
  if (tools.length) request.tools = tools;
  const configuredToolChoice = toolConfig(body.tool_choice);
  if (configuredToolChoice) request.toolConfig = configuredToolChoice;
  const configuredGeneration = generationConfig(body);
  if (configuredGeneration) request.generationConfig = configuredGeneration;
  const configuredThinking = thinkingConfig(body);
  if (configuredThinking)
    request.generationConfig = {
      ...((request.generationConfig as Record<string, unknown>) || {}),
      thinkingConfig: configuredThinking,
    };
  return request;
}

function responsesUsage(usage: UsageData): Record<string, unknown> {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
    input_tokens_details: { cached_tokens: usage.cacheReadInputTokens },
    output_tokens_details: { reasoning_tokens: usage.reasoningOutputTokens },
  };
}

function responseStatus(finishReason: unknown): string {
  return finishReason === "MAX_TOKENS" ? "incomplete" : "completed";
}

function functionCallItem(call: any): Record<string, unknown> {
  const callId = `call_${compactUuid().slice(0, 24)}`;
  const args = JSON.stringify(call?.args || {});
  if (call?.name === CUSTOM_TOOL_NAME) {
    const parsed = call.args?.input;
    return {
      id: `ctc_${callId}`,
      type: "custom_tool_call",
      status: "completed",
      call_id: callId,
      name: call.name,
      input: typeof parsed === "string" ? parsed : args,
    };
  }
  return {
    id: `fc_${callId}`,
    type: "function_call",
    status: "completed",
    call_id: callId,
    name: call?.name || "tool",
    arguments: args,
  };
}

function geminiUsageMetadata(response: any): UsageData {
  const usage = response?.usageMetadata || {};
  return {
    inputTokens: usage.promptTokenCount || 0,
    outputTokens: usage.candidatesTokenCount || 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: usage.cachedContentTokenCount || 0,
    reasoningOutputTokens: usage.thoughtsTokenCount || 0,
  };
}

export function geminiToResponses(response: any, model: string): any {
  const candidate = response?.candidates?.[0] || {};
  const parts = candidate?.content?.parts || [];
  const text = parts
    .filter((part: any) => typeof part?.text === "string")
    .map((part: any) => part.text)
    .join("");
  const output = [
    ...(text
      ? [
          {
            id: `msg_${compactUuid()}`,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text, annotations: [] }],
          },
        ]
      : []),
    ...parts
      .filter((part: any) => part?.functionCall)
      .map((part: any) => functionCallItem(part.functionCall)),
  ];
  const usage = geminiUsageMetadata(response);
  return {
    id: `resp_${compactUuid()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: responseStatus(candidate.finishReason),
    model,
    output,
    usage: responsesUsage(usage),
  };
}

export interface GeminiResponsesState {
  responseId: string;
  messageId: string;
  createdAt: number;
  sequence: number;
  started: boolean;
  textStarted: boolean;
  completed: boolean;
  text: string;
  textOutputIndex: number | null;
  nextOutputIndex: number;
}

export function makeGeminiResponsesState(): GeminiResponsesState {
  return {
    responseId: `resp_${compactUuid()}`,
    messageId: `msg_${compactUuid()}`,
    createdAt: Math.floor(Date.now() / 1000),
    sequence: 0,
    started: false,
    textStarted: false,
    completed: false,
    text: "",
    textOutputIndex: null,
    nextOutputIndex: 0,
  };
}

function formatSse(data: Record<string, unknown>): string {
  return `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function nextSequence(state: GeminiResponsesState): number {
  state.sequence += 1;
  return state.sequence;
}

function startEvents(state: GeminiResponsesState, model: string): string[] {
  if (state.started) return [];
  state.started = true;
  const response = {
    id: state.responseId,
    object: "response",
    created_at: state.createdAt,
    status: "in_progress",
    model,
    output: [],
  };
  return [
    formatSse({
      type: "response.created",
      sequence_number: nextSequence(state),
      response,
    }),
    formatSse({
      type: "response.in_progress",
      sequence_number: nextSequence(state),
      response,
    }),
  ];
}

function textStartEvents(state: GeminiResponsesState): string[] {
  if (state.textStarted) return [];
  state.textStarted = true;
  state.textOutputIndex = state.nextOutputIndex;
  state.nextOutputIndex += 1;
  const outputIndex = state.textOutputIndex;
  return [
    formatSse({
      type: "response.output_item.added",
      sequence_number: nextSequence(state),
      output_index: outputIndex,
      item: {
        id: state.messageId,
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: [],
      },
    }),
    formatSse({
      type: "response.content_part.added",
      sequence_number: nextSequence(state),
      item_id: state.messageId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    }),
  ];
}

function functionCallEvents(state: GeminiResponsesState, call: any): string[] {
  const item = functionCallItem(call);
  const outputIndex = state.nextOutputIndex;
  state.nextOutputIndex += 1;
  const custom = item.type === "custom_tool_call";
  const payload = custom ? item.input : item.arguments;
  const deltaType = custom
    ? "response.custom_tool_call_input.delta"
    : "response.function_call_arguments.delta";
  const doneType = custom
    ? "response.output_item.done"
    : "response.function_call_arguments.done";
  const delta = custom ? { delta: payload } : { delta: payload };
  const callMetadata = custom ? { call_id: item.call_id } : {};
  return [
    formatSse({
      type: "response.output_item.added",
      sequence_number: nextSequence(state),
      output_index: outputIndex,
      item: {
        ...item,
        status: "in_progress",
        ...(custom ? { input: "" } : { arguments: "" }),
      },
    }),
    formatSse({
      type: deltaType,
      sequence_number: nextSequence(state),
      item_id: item.id,
      output_index: outputIndex,
      ...callMetadata,
      ...delta,
    }),
    ...(custom
      ? []
      : [
          formatSse({
            type: doneType,
            sequence_number: nextSequence(state),
            item_id: item.id,
            output_index: outputIndex,
            arguments: item.arguments,
          }),
        ]),
    formatSse({
      type: "response.output_item.done",
      sequence_number: nextSequence(state),
      output_index: outputIndex,
      item,
    }),
  ];
}

export function geminiSSEToResponses(
  data: any,
  state: GeminiResponsesState,
  model: string,
): string[] {
  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const text = parts
    .filter((part: any) => typeof part?.text === "string")
    .map((part: any) => part.text)
    .join("");
  const output = startEvents(state, model);
  if (text) {
    state.text += text;
    output.push(...textStartEvents(state));
    output.push(
      formatSse({
        type: "response.output_text.delta",
        sequence_number: nextSequence(state),
        item_id: state.messageId,
        output_index: state.textOutputIndex ?? 0,
        content_index: 0,
        delta: text,
      }),
    );
  }
  for (const part of parts) {
    if (part?.functionCall)
      output.push(...functionCallEvents(state, part.functionCall));
  }
  return output;
}

export function completeGeminiResponses(
  state: GeminiResponsesState,
  model: string,
  usage: UsageData,
): string[] {
  if (state.completed) return [];
  state.completed = true;
  const output = startEvents(state, model);
  if (state.textStarted) {
    output.push(
      formatSse({
        type: "response.output_text.done",
        sequence_number: nextSequence(state),
        item_id: state.messageId,
        output_index: state.textOutputIndex ?? 0,
        content_index: 0,
        text: state.text,
      }),
      formatSse({
        type: "response.content_part.done",
        sequence_number: nextSequence(state),
        item_id: state.messageId,
        output_index: state.textOutputIndex ?? 0,
        content_index: 0,
        part: { type: "output_text", text: state.text, annotations: [] },
      }),
      formatSse({
        type: "response.output_item.done",
        sequence_number: nextSequence(state),
        output_index: state.textOutputIndex ?? 0,
        item: {
          id: state.messageId,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: state.text, annotations: [] }],
        },
      }),
    );
  }
  output.push(
    formatSse({
      type: "response.completed",
      sequence_number: nextSequence(state),
      response: {
        id: state.responseId,
        object: "response",
        created_at: state.createdAt,
        status: "completed",
        model,
        output: [],
        usage: responsesUsage(usage),
      },
    }),
    formatSse({ type: "response.done", sequence_number: nextSequence(state) }),
  );
  return output;
}
