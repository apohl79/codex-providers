> ⚠️ This document was created with Claude AI. Please review before sharing externally.

# Spec: Inter-Agent Content-Encryption Endpoint

Status: Draft — decision made (Option A)
Owner: unassigned
Scope: `src/handlers`, `src/upstream`, `src/providers` (anthropic + codex paths)

## 1. Problem

Codex multi-agent (`multi_agent_v2`) fails whenever an agent running through the
auth2api **anthropic** provider spawns or messages an agent that runs through the
**openai/codex** provider (or vice versa). The child's first inference request to
the real ChatGPT Codex backend aborts with:

```
stream disconnected before completion:
Encrypted function output content could not be decrypted or decoded.
```

The failure occurs before the child produces a single token, so no work is done.

### Root cause (verified)

Codex carries inter-agent task/messages as an `agent_message` item whose payload
is an `encrypted_content` field (Codex protocol: `AgentMessageInputContent::EncryptedContent`).
Codex does **not** encrypt this field locally — it relies on the OpenAI/ChatGPT
Codex backend to seal the tool-call `message` argument server-side.

Observed in Codex session rollouts:

| Parent → Child provider | `message` / `encrypted_content` on the wire | Result |
| --- | --- | --- |
| openai → openai | `gAAAAAB...` (504 chars, **Fernet token**) | success |
| anthropic → anthropic | plaintext (no openai child to decrypt it) | success |
| **anthropic → openai** | plaintext, e.g. `search for the weather ...` (51 chars) | **fails** |

When the parent runs on the OpenAI provider, the backend returns the tool
argument already sealed as a Fernet token. When the parent runs through
auth2api's anthropic provider, auth2api does not perform that sealing, so the
`encrypted_content` stays plaintext. The openai-backed child then forwards this
plaintext to the ChatGPT backend, which tries to decrypt a field typed as
encrypted content, fails to decode it, and drops the stream.

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

Allow a Codex agent running through auth2api to spawn/message an openai/codex
agent (and receive replies) without the ChatGPT backend rejecting inter-agent
content, so `multi_agent_v2` works across mixed-provider topologies.

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

## 4. Chosen design — Option A: delegate sealing to the ChatGPT backend

Because the real encryption key lives in the ChatGPT backend and is not available
to auth2api, the only design that supports a child talking directly to
`chatgpt.com/backend-api/codex` is to **delegate sealing/unsealing to that same
backend**. Option A is selected. Options B and C are recorded as rejected
alternatives in §4.1.

auth2api's **anthropic** provider path detects a Codex inter-agent tool argument
that must be encrypted and delegates the sealing to the ChatGPT Codex backend via
the existing openai/codex account pool, then substitutes the returned token
before the message reaches the anthropic upstream. On the reverse path it asks
the same backend to decrypt tokens the openai-backed child produced before the
anthropic-backed parent consumes them.

Requirements:

- **Backend sealing mechanism.** The ChatGPT Codex backend already produces the
  `gAAAAAB...` token for openai-provider runs, so a sealing capability exists.
  Its exact surface must be captured before implementation (see §7 Q1); the
  design assumes a callable seal/unseal path reachable with a codex account
  token. If the capability turns out to be inline-only, see §4.2.
- **Account token.** A valid ChatGPT/codex account token from the existing codex
  account pool (`src/accounts`, `src/providers/codex.ts`) authorizes the
  seal/unseal calls. Reuse the pool's cooldown/refresh/failover.
- **Reverse path.** The child→parent reply path unseals via the same backend so
  the anthropic-backed parent receives readable content.

Risk and dependency: Option A depends on a backend capability that is not yet
documented; the primary open question (§7 Q1) must be answered before build.
§4.2 defines the fallback if that capability is not callable.

### 4.1 Rejected alternatives

- **Option B — auth2api-owned symmetric envelope.** auth2api seals with its own
  Fernet key. Rejected as the primary design because it only works when **every**
  agent traverses auth2api; it cannot satisfy a child that talks to the real
  ChatGPT backend, which cannot decrypt an auth2api-owned token. Retain only if a
  deployment forces all agents (including the openai provider) through auth2api.
- **Option C — provider-consistency guard.** Reject the cross-provider mismatch
  early with a structured 400 instead of a fix. Not selected as the design, but
  see §4.2 — it is reused as Option A's degraded fallback.

### 4.2 Fallback if backend sealing is not callable

If §7 Q1 reveals the backend only seals content implicitly inside `/responses`
(no callable seal/unseal surface), auth2api cannot implement Option A and must
degrade to the Option C guard: on the anthropic path, when the outbound body
contains an `agent_message` with plaintext `encrypted_content` destined for
cross-provider delivery, return a structured 400 that explains the
provider-consistency requirement. This converts an opaque dropped stream into an
actionable error while the topology stays single-provider.

## 5. Endpoint contract

A new internal handler encapsulates content sealing/unsealing. It is not a public
API surface; it is invoked inside the anthropic translation path.

```
sealInterAgentContent(plaintext: string, ctx): Promise<string>   // -> gAAAA... token
openInterAgentContent(token: string, ctx): Promise<string>       // -> plaintext
```

- `ctx` carries the codex account/token used to authorize the backend
  seal/unseal calls (from the existing codex account pool).
- Both are pure with respect to auth2api state except for the account lookup and
  the backend round-trip.
- Errors are typed: `SealUnavailable` (backend capability not callable → trigger
  the §4.2 guard), `SealBackendError` (backend call failed), `OpenDecodeError`
  (returned token could not be decoded).

### Where it plugs in

- Request path: in the anthropic handler, after the Responses→Anthropic body is
  built, walk `messages` for `agent_message`/inter-agent content and seal any
  plaintext payload destined for an openai-backed recipient.
- Response path: when relaying a child openai agent's output back to an
  anthropic-backed parent, `open` any token the parent cannot decrypt.

(Reference for the message-shape handling: the existing
`responsesToAnthropic` translator already has an `agent_message` branch and a
trailing-assistant-prefill guard in `src/upstream/translator.ts`.)

## 6. Detection rule

A payload needs sealing when **all** hold:

1. The item is a Codex inter-agent envelope (`type: "agent_message"`, or a
   tool-call `message` argument for `spawn_agent` / `send_message` /
   `followup_task`).
2. Its content is **not** already a Fernet token (does not start with `gAAAA`
   after base64url normalization / fails the version+length structural check).
3. The routing target for the counterpart agent is the openai/codex provider.

Structural Fernet check (no decryption needed): base64url-decode, assert first
byte `0x80`, assert `len(raw) >= 1 + 8 + 16 + 32` and `(len(raw) - 57) % 16 == 0`.

## 7. Open questions (must resolve before implementation)

1. **Backend sealing capability (blocking, Option A critical path).** What
   endpoint/mechanism does the ChatGPT Codex backend use to produce the
   `gAAAAAB...` tool-argument token, and is it callable independently of a full
   `/responses` turn? Capture an openai-provider Codex `spawn_agent` run's HTTPS
   traffic to the `chatgpt.com/backend-api/codex` host and record the
   request/response that yields the token. If it is callable, Option A proceeds;
   if it is inline-only, fall back to §4.2. This must be answered before build.
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
   chosen Option A.

## 8. Acceptance criteria

- An anthropic-provider parent can `spawn_agent` with an openai/codex
  `agent_type` and the child completes its first turn without the
  "Encrypted function output content could not be decrypted or decoded" error.
- Same-provider spawns (openai→openai, anthropic→anthropic) continue to pass.
- No plaintext inter-agent payload is sent to the ChatGPT backend in a field the
  backend treats as encrypted.
- If sealing is unavailable, the caller receives a typed, actionable error
  (Option C) rather than a dropped stream.
- Encryption keys/tokens never appear in logs or stats.
- Unit tests cover: detection rule (positive/negative), structural Fernet check,
  the backend seal/unseal delegation (against a mock backend), and the §4.2
  degraded-guard error when sealing is unavailable.

## 9. Test plan

- Unit: Fernet structural validator; detection rule truth table across the three
  topologies; translator integration for the `agent_message` seal/unseal hooks;
  `SealUnavailable` → §4.2 guard path.
- Integration: mock ChatGPT backend exposing the seal/unseal capability plus a
  `/responses` that rejects non-Fernet `encrypted_content` (reproduces the
  current failure) and accepts backend-sealed tokens (proves the fix).
- Regression: existing `tests/unit.test.ts` `responsesToAnthropic` suite and the
  `tests/responses-translator.test.ts` suite must stay green.

## 10. Evidence appendix

- Codex protocol: `AgentMessageInputContent::{InputText,EncryptedContent}`,
  `InterAgentCommunication::{new_encrypted,to_model_input_item}`.
- Codex has no local Fernet/seal implementation for message content (only
  agent-identity Curve25519 unseal for task ids).
- Failing rollout: anthropic parent → openai child, `encrypted_content` = 51-byte
  plaintext, child produced 0 tokens.
- Working rollout: openai parent → openai child, `message` arg = 504-char Fernet
  token, child cached the parent prefix and returned a result.
