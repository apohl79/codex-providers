> ⚠️ This document was created with Claude AI. Please review before sharing externally.

# Spec: Inter-Agent Content-Encryption Guard

Status: Draft - runtime capture complete; Claude plaintext pass-through and Codex guard implemented
Owner: unassigned
Scope: `src/handlers`, `src/upstream` (Claude `/v1/responses` translation and Codex `/v1/responses` guard path)

## 1. Problem

Codex multi-agent (`multi_agent_v2`) has two inter-agent content failure modes
when auth2api is in the path:

1. Same-provider Claude runs can lose the task payload because Codex stores the
   parent tool argument in `agent_message.encrypted_content`, while auth2api's
   Claude translator previously replaced every `encrypted_content` value with a
   placeholder.
2. Mixed anthropic→openai/codex runs forward plaintext into a ChatGPT backend
   field that expects a backend-sealed token. The child's first inference request
   to the real ChatGPT Codex backend aborts with:

```
stream disconnected before completion:
Encrypted function output content could not be decrypted or decoded.
```

The failure occurs before the child produces a single token, so no work is done.

### Root cause (verified)

Codex carries inter-agent task/messages as an `agent_message` item whose payload
includes an `encrypted_content` field (Codex protocol:
`AgentMessageInputContent::EncryptedContent`). Codex does **not** encrypt this
field locally. The OpenAI/ChatGPT Codex backend can seal the model-supplied tool
`message` argument server-side, but Claude-backed parents send the model-supplied
string through as plaintext in the same transport field.

Observed in Codex session rollouts:

| Parent → Child provider | `message` / `encrypted_content` on the wire | Result |
| --- | --- | --- |
| openai → openai | `gAAAAAB...` (504 chars, **Fernet token**) | success |
| anthropic → anthropic | plaintext in `encrypted_content` | failed before fix; now translated to Anthropic text |
| **anthropic → openai** | plaintext, e.g. `search for the weather ...` (51 chars) | **fails** |

When the parent runs on the OpenAI provider, the backend returns the tool
argument already sealed as a Fernet token. When the parent runs through
auth2api's anthropic provider, auth2api does not perform that sealing, so the
`encrypted_content` stays plaintext. For an anthropic child, auth2api must treat
non-Fernet `encrypted_content` as readable plaintext during Responses→Anthropic
translation. For an openai/codex child, forwarding that plaintext to ChatGPT is
invalid because the backend tries to decrypt a field typed as encrypted content,
fails to decode it, and drops the stream.

The error text originates in the upstream ChatGPT backend; it exists in neither
Codex nor auth2api.

### Verified Fernet token structure (from a working openai→openai spawn)

```
prefix          : "gAAAAAB"  (base64url of version 0x80 + timestamp)
version byte    : 0x80 (128)
timestamp       : 8 bytes, big-endian unix seconds (matched the spawn wall time)
IV              : 16 bytes
ciphertext      : AES-128-CBC, PKCS7 padded
HMAC            : 32 bytes, SHA-256, trailing
total raw       : 377 bytes for a 51-byte plaintext task
```

This is a standard [Fernet](https://github.com/fernet/spec/blob/master/Spec.md)
token. The signing/encryption key is held by the ChatGPT backend and is **not**
available to auth2api. That constraint drives the design options below.

## 2. Goal

Keep same-provider Claude inter-agent delivery readable, and prevent
mixed-provider Codex multi-agent runs from forwarding plaintext inter-agent
content into a ChatGPT backend field typed as encrypted content. The current
implementable outcome is:

- Claude target: pass non-Fernet `agent_message.encrypted_content` through as
  text during Anthropic translation.
- Codex target: return a typed provider-consistency error before the upstream
  dropped-stream failure.

### Non-goals

- Re-implementing Codex agent-identity task-id registration (separate, already
  handled by Codex against `auth.openai.com`).
- Encrypting reasoning `encrypted_content` or `function_call_output`
  `encrypted_content` produced by normal (non-inter-agent) turns. Those are
  round-tripped opaquely and are out of scope unless testing shows otherwise.
- Changing Codex itself.

## 3. Constraints

- auth2api does not possess the ChatGPT backend's Fernet key. It cannot produce a
  token the backend will accept, and cannot decrypt a token the backend produced.
- The `encrypted_content` field is opaque to auth2api on both the request path
  (Codex → backend) and response path (backend → Codex).
- Whatever auth2api does must keep single-provider topologies
  (openai→openai, anthropic→anthropic) working unchanged.

## 4. Decision outcome - Claude plaintext pass-through plus Codex guard

Because the real encryption key lives in the ChatGPT backend and is not available
to auth2api, the only design that would support a child talking directly to
`chatgpt.com/backend-api/codex` is to **delegate sealing/unsealing to that same
backend**. That was Option A. Runtime instrumentation of Codex on 2026-07-06
showed no separate callable seal/unseal request: the `gAAAAAB...` token appears
inline in the parent `/responses` WebSocket stream as the `spawn_agent.message`
tool argument, and the child later forwards the same value as
`agent_message.encrypted_content` in its own `/responses` request.

Therefore Option A is **not currently implementable** from observed Codex client
behavior. The selected implementable behavior has two parts:

- On the Claude target path, detect that `encrypted_content` is not a Fernet
  token and pass it through as text for Anthropic Messages.
- On the Codex target path, detect delivery that would send plaintext in
  `encrypted_content`, then return a typed provider-consistency error before the
  ChatGPT backend receives an undecryptable payload.

Requirements:

- **Backend sealing mechanism.** The ChatGPT Codex backend already produces the
  `gAAAAAB...` token for openai-provider runs, so a sealing capability exists.
  Codex client source inspection in `../code/codex` shows the client does not
  seal inter-agent tool arguments locally: `spawn_agent`, `send_message`, and
  `followup_task` pass the model-supplied tool `message` string directly into
  `InterAgentCommunication::encrypted_content`, and the model input serializer
  forwards that opaque string as `type: encrypted_content`. Local Codex
  sub-agent captures match that source shape: anthropic-parent→openai-child
  stored the task plaintext in `encrypted_content` and failed, while
  openai-parent→openai-child stored a Fernet-shaped token and succeeded. The
  captures and client source do **not** expose a callable seal/unseal surface.
  Instrumented runtime evidence shows the sealing result is delivered inline by
  the parent `/responses` stream; no independent seal/unseal request was made by
  the Codex client.
- **Account token.** No standalone seal/unseal call is known to be authorizable
  with the existing codex account pool (`src/accounts`, `src/providers/codex.ts`).
  If a backend API is later found, it can revive Option A.
- **Reverse path.** The child→parent reply path remains unverified for a mixed
  provider topology. Do not attempt reverse-path unsealing until a callable
  backend surface is identified.

Risk and dependency: without a callable backend seal/unseal surface, auth2api
cannot synthesize tokens accepted by the real ChatGPT backend. The safe
implementation is Claude plaintext pass-through for non-Fernet same-provider
content, plus the §4.2 guard for Codex-targeted plaintext.

### 4.1 Alternatives considered

- **Option B — auth2api-owned symmetric envelope.** auth2api seals with its own
  Fernet key. Rejected as the primary design because it only works when **every**
  agent traverses auth2api; it cannot satisfy a child that talks to the real
  ChatGPT backend, which cannot decrypt an auth2api-owned token. Retain only if a
  deployment forces all agents (including the openai provider) through auth2api.
- **Option C — provider-consistency guard.** Reject the cross-provider mismatch
  early with a structured 400 instead of a full mixed-provider fix. Selected
  after runtime capture showed no callable backend seal/unseal surface.

### 4.2 Provider-consistency guard

Runtime capture showed the backend seals content implicitly inside `/responses`
with no observed callable seal/unseal surface. auth2api must use the Option C
guard: on the codex-native `/v1/responses` path, when the outbound body contains
an `agent_message` with plaintext `encrypted_content`, return a structured 400
that explains the provider-consistency requirement. This converts an opaque
dropped stream into an actionable error.

### 4.3 Claude same-provider plaintext pass-through

For the Anthropic target path, `responsesToAnthropic` must preserve readable
task content carried in `agent_message.encrypted_content` when the value is not a
Fernet token. Fernet-shaped values remain masked as `[encrypted inter-agent
content]` because auth2api cannot decrypt them.

## 5. Translation and guard contract

A new internal guard detects unsupported mixed-provider inter-agent delivery. It
is not a public API surface.

```
assertSupportedInterAgentContentDelivery(body, ctx): Result<void, ProviderConsistencyError>
```

- `ctx` carries the target child provider.
- The guard is pure with respect to auth2api state.
- Errors are typed: `ProviderConsistencyError` for plaintext
  `encrypted_content` that would be forwarded to the real ChatGPT backend in a
  mixed-provider topology.

### Where it plugs in

- Request path: in the codex-native `/v1/responses` path, before proxying to the
  ChatGPT backend, walk `input` for `agent_message`/inter-agent content and
  reject any plaintext payload destined for the codex provider.
- Anthropic translation path: in `responsesToAnthropic`, walk `agent_message`
  content and pass through non-Fernet `encrypted_content` as text while masking
  Fernet-shaped values.
- Response path: no reverse-path unsealing is implemented without a callable
  backend surface.

(Reference for the message-shape handling: the existing
`responsesToAnthropic` translator already has an `agent_message` branch and a
trailing-assistant-prefill guard in `src/upstream/translator.ts`.)

## 6. Detection rule

A payload needs the provider-consistency guard when **all** hold:

1. The item is a Codex inter-agent envelope (`type: "agent_message"`, or a
   tool-call `message` argument for `spawn_agent` / `send_message` /
   `followup_task`).
2. Its content is **not** already a Fernet token (does not start with `gAAAA`
   after base64url normalization / fails the version+length structural check).
3. The routing target for the counterpart agent is the openai/codex provider.

Structural Fernet check (no decryption needed): base64url-decode, assert first
byte `0x80`, assert `len(raw) >= 1 + 8 + 16 + 32` and `(len(raw) - 57) % 16 == 0`.

## 7. Runtime findings and remaining open questions

1. **Backend sealing capability (answered for observed Codex client behavior).**
   Local captures, source inspection, and instrumented runtime capture on
   2026-07-06 confirm the local Codex behavior and the client-observed backend
   mechanism:
   - Anthropic parent (`model_provider: "anthropic"`) spawning an openai child
     (`agent_role: "general-purpose-gpt"`, `model_provider: "openai"`) persisted
     `inter_agent_communication` with empty plaintext `content` and a 51-byte
     `encrypted_content` value beginning with the plaintext task prefix
     `search `, then the child failed with "Encrypted function output content
     could not be decrypted or decoded."
   - OpenAI parent spawning an openai child persisted `inter_agent_communication`
     with empty plaintext `content` and a Fernet-shaped `encrypted_content`
     value beginning `gAAAAAB` (1124 chars), and the child ran successfully.
   - Codex client source in `../code/codex` passes the model-supplied tool
     `message` argument through as `encrypted_content`. It does not perform
     local encryption or call a local seal helper.
   - Instrumented Codex runtime capture showed the OpenAI-backed parent
     `/responses` WebSocket stream emitted `spawn_agent.arguments.message` as a
     `gAAAAAB...` token (248 chars in the rebuilt-binary controlled run;
     `/tmp/codex-inter-agent-trace-20260706162010.jsonl`, line 13).
   - The child `/responses` request then contained an `agent_message` from
     `/root` to `/root/capture_probe` with the same `encrypted_content` prefix
     and length (line 24).
   - The instrumented run recorded one `GET /models` request, ten `/responses`
     WebSocket requests, and ninety-three streamed events. It recorded no
     separate seal/unseal request between the parent tool call and child
     request.

   Conclusion: for the observed Codex client behavior, sealing is inline in the
   parent `/responses` turn and is not callable independently. Implement §4.2
   unless a new backend API is later discovered outside the current Codex client
   request path.
2. **Reverse path.** Confirm whether child→parent replies also require
   sealing/unsealing, or only the initial task delivery. Rollout evidence shows
   the failure on the child's first turn (task delivery); reply-path behavior is
   unverified.
3. **Scope of `encrypted_content`.** Confirm that only inter-agent
   `agent_message` content is affected, not reasoning/function-output
   `encrypted_content` on ordinary turns.
4. **Key custody (only if the rejected Option B is later revived).** If a
   deployment forces all agents through auth2api and adopts self-contained
   sealing, decide key rotation and multi-instance sharing. Not applicable to the
   selected provider-consistency guard.

## 8. Acceptance criteria

- Mixed anthropic→openai inter-agent delivery that would send plaintext in
  `encrypted_content` is rejected before the ChatGPT backend receives the
  request.
- Same-provider spawns continue to pass: openai→openai keeps Fernet-shaped
  tokens opaque, and anthropic→anthropic passes plaintext task payloads through
  to Anthropic text.
- No plaintext inter-agent payload is sent to the ChatGPT backend in a field the
  backend treats as encrypted.
- The caller receives a typed, actionable provider-consistency error rather than
  a dropped stream.
- Encryption keys/tokens never appear in logs or stats.
- Unit tests cover: detection rule (positive/negative), structural Fernet check,
  provider-consistency guard, and Claude same-provider plaintext pass-through.

## 9. Test plan

- Unit: Fernet structural validator; detection rule truth table across the three
  topologies; translator integration for the provider-consistency guard; Anthropic
  translator pass-through for non-Fernet inter-agent content and masking for
  Fernet-shaped content.
- Integration: mock ChatGPT backend with `/responses` rejecting non-Fernet
  `encrypted_content` to reproduce the current failure, plus auth2api behavior
  proving the request is rejected before proxying when the guard applies.
- Regression: existing `tests/unit.test.ts` `responsesToAnthropic` suite and the
  `tests/responses-translator.test.ts` suite must stay green.

## 10. Evidence appendix

- Codex protocol: `AgentMessageInputContent::{InputText,EncryptedContent}`,
  `InterAgentCommunication::{new_encrypted,to_model_input_item}`.
- Codex has no local Fernet/seal implementation for message content (only
  agent-identity Curve25519 unseal for task ids).
- Same-provider Claude failure mode: before the translator fix, auth2api replaced
  all `agent_message.encrypted_content` with `[encrypted inter-agent content]`,
  which discarded plaintext tasks carried in the Codex transport field.
- Failing rollout: anthropic parent → openai child, `encrypted_content` = 51-byte
  plaintext, child produced 0 tokens.
- Working rollout: openai parent → openai child, `message` arg = 504-char Fernet
  token, child cached the parent prefix and returned a result.
- 2026-07-06 local sub-agent capture:
  - Anthropic parent session
    `~/.codex/sessions/2026/07/06/rollout-2026-07-06T11-58-17-019f36dd-3ede-79d3-9397-d36ee4c40d06.jsonl`
    spawned openai child session
    `~/.codex/sessions/2026/07/06/rollout-2026-07-06T11-58-28-019f36dd-6b98-7333-a4f6-f8d9ab8ce529.jsonl`;
    child local `inter_agent_communication` rows had `encrypted_content`
    prefix `search `, length 51, and the parent recorded the decrypt/decode
    stream failure.
  - OpenAI parent session
    `~/.codex/sessions/2026/07/06/rollout-2026-07-06T14-41-15-019f3772-72fd-7341-a5d7-f0af9b36d958.jsonl`
    spawned openai child session
    `~/.codex/sessions/2026/07/06/rollout-2026-07-06T14-42-47-019f3773-dae1-73b3-9b9f-c380f81ad263.jsonl`;
    child local `inter_agent_communication` row had `encrypted_content`
    prefix `gAAAAAB`, length 1124, and the child completed.
  - Local Codex logs/proxy state did not contain a
    `chatgpt.com/backend-api/codex` HTTPS request/response transcript or a
    separate seal/unseal endpoint.
- 2026-07-06 `../code/codex` client source inspection:
  - `codex-rs/core/src/tools/handlers/multi_agents_v2.rs` defines
    `communication_from_tool_message`, which calls
    `InterAgentCommunication::new_encrypted(..., message, true)` with the
    model-supplied tool argument as-is.
  - `codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs` calls
    `communication_from_tool_message(...)` for plaintext spawn tool input before
    creating the child `Op::InterAgentCommunication`.
  - `codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs` uses the
    same helper for `send_message` and `followup_task`.
  - `codex-rs/protocol/src/protocol.rs` sets plaintext `content` to empty in
    `new_encrypted` and serializes `encrypted_content` as agent-message
    `type: encrypted_content`.
  - `codex-rs/core/tests/suite/subagent_notifications.rs` pins the pass-through
    contract: `"opaque-encrypted-message"` supplied as the spawn tool `message`
    is expected verbatim in the child request's `encrypted_content`.
  - Source search found no client-side seal/unseal endpoint; known Codex API
    paths include `responses`, `responses/compact`, `memories/trace_summarize`,
    `realtime/calls`, and `alpha/search`.
- 2026-07-06 instrumented `../code/codex` runtime capture:
  - Instrumentation was added behind `CODEX_INTER_AGENT_TRACE` in
    `codex-rs/codex-api` request and stream boundaries, then built with
    `../code/codex/scripts/build_apohl79_release.sh --skip-github-release`.
  - Built package:
    `/Users/andreas.pohl/workspace/code/codex/dist/apohl79/0.142.4-apohl79/codex-package-aarch64-apple-darwin`.
  - Capture trace:
    `/tmp/codex-inter-agent-trace-20260706162010.jsonl`.
  - Parent OpenAI-backed `/responses` WebSocket stream emitted
    `spawn_agent.arguments.message` with prefix `gAAAAAB`, length 248
    (trace line 13).
  - Child `/responses` WebSocket request sent an `agent_message` from `/root` to
    `/root/capture_probe` with `encrypted_content` prefix `gAAAAAB`, length 248
    (trace line 24).
  - Recorded outbound paths were only one `GET /models` request and ten
    `/responses` WebSocket requests; no separate seal/unseal request was
    observed.
