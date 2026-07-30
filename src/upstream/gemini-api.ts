import { Config } from "../config";
import { UpstreamCallContext } from "../providers/types";
import { withTimeoutSignal } from "../utils/abort";

type GeminiCallOptions = UpstreamCallContext & { baseUrl: string };

export async function callGeminiGenerateContent(
  options: GeminiCallOptions,
): Promise<Response> {
  const requestBody = options.body ?? options.request.body;
  const model =
    typeof requestBody?.model === "string" ? requestBody.model.trim() : "";
  if (!model) throw new Error("Gemini GenerateContent requires a model");

  const { model: _model, stream, ...body } = requestBody;
  const method = stream ? "streamGenerateContent?alt=sse" : "generateContent";
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const url = `${baseUrl}/models/${encodeURIComponent(model)}:${method}`;
  const timeoutMs = stream
    ? options.config.timeouts["stream-messages-ms"]
    : options.config.timeouts["messages-ms"];

  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: stream ? "text/event-stream" : "application/json",
      "x-goog-api-key": options.account.token.accessToken,
    },
    body: JSON.stringify(body),
    signal: withTimeoutSignal(timeoutMs, options.signal),
  });
}
