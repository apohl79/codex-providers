# Codex Providers — Advanced Guide

For installation, supported providers, and everyday commands, see [README.md](README.md).

This guide covers direct proxy login, configuration, API compatibility, deployment, model routing, and operations.

## Direct provider login

Use `node dist/index.js --login --provider=<provider>` to configure the proxy directly. The default provider is `anthropic`.

### Auto mode (requires local browser)

```bash
# Claude (default)
node dist/index.js --login

# Claude with a direct Anthropic API key
export ANTHROPIC_API_KEY="<your-anthropic-api-key>"
node dist/index.js --login --provider=anthropic --auth=api-key

# Codex (ChatGPT Plus/Pro)
node dist/index.js --login --provider=codex

# DeepSeek can use an environment variable for non-interactive startup.
export DEEPSEEK_API_KEY="<your-deepseek-api-key>"

# Or save it interactively in auth-dir (default: ~/.codex-providers).
node dist/index.js --login --provider=deepseek

# Gemini can use an environment variable for non-interactive startup.
export GEMINI_API_KEY="<your-gemini-api-key>"

# Or save it interactively in auth-dir (default: ~/.codex-providers).
node dist/index.js --login --provider=google

# Cursor (experimental; opens a browser to authorize your Cursor account)
node dist/index.js --login --provider=cursor

# Cursor — fall back to importing the local Cursor desktop login instead of using the browser
node dist/index.js --login --provider=cursor --cursor-import-local
node dist/index.js --login --provider=cursor --cursor-storage=/path/to/state.vscdb
```

Anthropic OAuth and Codex open a browser URL. After authorizing, the callback is handled automatically. The Anthropic OAuth flow uses port `54545`; the Codex flow uses port `1455` — make sure neither is blocked by your firewall. `--login --provider=anthropic --auth=api-key` securely prompts for an Anthropic key when `ANTHROPIC_API_KEY` is unset, then saves it in `auth-dir`; `--login --provider=google` does the same for Gemini. Gemini calls use the native `models.generateContent` and `models.streamGenerateContent` APIs, not Google's OpenAI-compatible endpoint. Cursor uses a different "deep-link" PKCE flow: it prints a `https://cursor.com/loginDeepControl?...` URL, you click "Yes, Log In" in your browser, and `codex-providers` polls `api2.cursor.sh/auth/poll` until the token is issued — no callback port required. Pass `--cursor-import-local` (or `--cursor-storage=...`) if you'd rather pull the existing token out of your Cursor desktop install.

When the interactive `codex-providers` wizard selects Claude OAuth or an Anthropic API key, it keeps only that persisted Claude authentication method in `auth-dir`; the removed opposite-method files are saved as timestamped `*.bak-codex-providers-*` backups.

### Manual mode (for remote servers)

```bash
node dist/index.js --login --manual
node dist/index.js --login --provider=codex --manual
```

Open the printed URL in your browser. After authorizing, your browser will redirect to a `localhost` URL that fails to load — copy the full URL from the address bar and paste it back into the terminal.

You can run `--login` multiple times to add additional accounts (per provider). codex-providers stores credentials side-by-side in `auth-dir` (`claude-<email>.json`, `codex-<email>.json`, `deepseek-<email>.json`, `google-<email>.json`, and `cursor-<email>.json`) and routes inbound requests to the matching pool by model name. Existing `gemini-<email>.json` credentials remain readable during migration. API-key login writes an owner-only credential file; environment API keys remain in memory only. Logging in to only one provider is fine — the others simply have no advertised models.

### Model advertisements

`codex-providers` persists the models selected for a Claude, DeepSeek, or Google profile in `config.yaml` under `model-advertisements`. `GET /v1/models?provider=<provider>` then returns exactly that provider's selected list. Omit a provider from this setting to retain its complete built-in catalog. Restart the proxy after changing model advertisements so it reloads the configuration.

> **Note on Codex:** The codex provider relays your ChatGPT Plus/Pro subscription quota. OpenAI's ToS does not officially permit relaying ChatGPT sessions through third-party tools — use this for your own personal local consumption only.

> **Note on Cursor:** The cursor provider is a research-only integration built from non-public, reverse-engineered Cursor APIs (`api2.cursor.sh` over HTTP/2, Connect-RPC + protobuf). It may break when Cursor changes client versions, may violate Cursor's terms, and should be used only for local personal experiments.

## Starting the server

```bash
node dist/index.js
```

The server starts on `http://127.0.0.1:8317` by default. On first run, an API key is auto-generated and saved to `config.yaml`.

### Installer and runner

The one-line installer clones the project into `$XDG_DATA_HOME/codex-providers` when `XDG_DATA_HOME` is set, otherwise into `~/.local/share/codex-providers`. It then writes `codex-providers` to `~/bin` when that directory exists, otherwise to `~/.local/bin`. Re-running the installer fast-forwards the managed checkout before reinstalling the command. It also adds a managed block to `~/.zshrc` that runs `codex-providers proxy ensure` when a new zsh shell starts. Installation removes this repository's previous `auth2api` runner and hook; no compatibility command is retained.

```bash
curl -fsSL https://raw.githubusercontent.com/apohl79/codex-providers/main/install.sh | bash
codex-providers setup
codex-providers proxy ensure
codex-providers proxy stop
codex-providers proxy logs
codex-providers doctor
```

Set `CODEX_PROVIDERS_MANAGED_DIR` to override the managed checkout path. Running `./install.sh` from an existing repository checkout remains supported and installs a runner backed by that checkout instead.

`codex-providers setup` starts the interactive provider wizard, and `codex-providers configure <provider>` chooses Claude, DeepSeek, or Gemini non-interactively. `codex-providers proxy ensure` checks the configured `/health` endpoint and exits silently if the server is already ready. Otherwise it installs dependencies when needed, builds `dist/index.js` when needed, starts `node dist/index.js --config=<repo>/config.yaml` in the background, and waits for the health endpoint to become ready. `codex-providers proxy stop` verifies the runner-owned PID before sending `SIGTERM`; use `codex-providers proxy stop && codex-providers proxy ensure` for a clean restart. `codex-providers proxy logs` prints the background log, and `codex-providers doctor` checks its health endpoint. Background logs are written to `~/.local/state/codex-providers/server.log` by default.

To remove the runner and the managed `~/.zshrc` ensure block while preserving provider credentials and the managed source checkout:

```bash
curl -fsSL https://raw.githubusercontent.com/apohl79/codex-providers/main/install.sh | bash -s -- --uninstall
```

## Configuration

Copy `config.example.yaml` to `config.yaml` and edit as needed:

```yaml
host: "" # bind address, empty = 127.0.0.1
port: 8317

auth-dir: "~/.codex-providers" # where provider credentials are stored

deepseek:
  api-key-env: "DEEPSEEK_API_KEY" # environment variable containing the key
  base-url: "https://api.deepseek.com/anthropic"

api-keys:
  - "your-api-key-here" # clients use this to authenticate

body-limit: "200mb" # maximum JSON request body size, useful for large-context usage

timeouts:
  messages-ms: 120000 # non-stream /v1/messages timeout
  stream-messages-ms: 600000 # stream /v1/messages timeout (10 min, suitable for Claude Code)
  count-tokens-ms: 30000 # /v1/messages/count_tokens timeout

# Request fingerprinting — controls how codex-providers mimics Claude Code CLI
cloaking:
  cli-version: "2.1.88" # CLI version to impersonate
  entrypoint: "cli" # billing attribution entrypoint (cli, mcp, sdk, etc.)

debug: "off" # off | errors | verbose
```

`debug` supports three levels:

- `off`: no extra logs
- `errors`: log upstream/network failures and upstream error bodies
- `verbose`: include `errors` logs plus per-request method, path, status, and duration

Cursor's reverse-engineered headers can be overridden if the upstream version gate changes. `agent-base-url` is the legacy alias for the chat host; both keys point at the same backend now (`api2.cursor.sh`).

```yaml
cloaking:
  cursor:
    client-version: "2.3.41"
    client-type: "ide"
    agent-base-url: "https://api2.cursor.sh"
    api-base-url: "https://api2.cursor.sh"
```

## Usage

Use any OpenAI-compatible client pointed at `http://127.0.0.1:8317`:

```bash
curl http://127.0.0.1:8317/v1/chat/completions \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-5",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 1024
  }'
```

### Available models

`GET /v1/models` lists only models for providers you've actually configured. DeepSeek API-key login stores a `deepseek-*.json` credential in `auth-dir` with owner-only permissions. Claude uses the built-in model set below. The codex list is **fetched live** from `chatgpt.com/backend-api/codex/models` (cached 5 minutes, ETag-aware) so it always matches what your account can actually serve. Cursor models are fetched from Cursor's internal AvailableModels endpoint when possible, with a small fallback list. The current supported set at the time of writing:

| Model ID                                             | Provider  | Description                                        |
| ---------------------------------------------------- | --------- | -------------------------------------------------- |
| `claude-opus-5`                                      | anthropic | Claude Opus 5                                      |
| `claude-opus-4-8`                                    | anthropic | Claude Opus 4.8                                    |
| `claude-fable-5`                                     | anthropic | Claude Fable 5                                     |
| `claude-sonnet-5`                                    | anthropic | Claude Sonnet 5                                    |
| `claude-haiku-4-5-20251001`                          | anthropic | Claude Haiku 4.5                                   |
| `gpt-5.5`                                            | codex     | GPT-5.5 (reasoning model)                          |
| `gpt-5.4`                                            | codex     | GPT-5.4                                            |
| `gpt-5.4-mini`                                       | codex     | GPT-5.4 Mini                                       |
| `gpt-5.3-codex`                                      | codex     | GPT-5.3 (Codex variant)                            |
| `gpt-5.2`                                            | codex     | GPT-5.2                                            |
| `deepseek-v4-pro`                                    | deepseek  | DeepSeek V4 Pro                                    |
| `deepseek-v4-flash`                                  | deepseek  | DeepSeek V4 Flash                                  |
| `cursor-claude-opus-4-7-medium`                      | cursor    | Claude Opus 4.7 routed through Cursor              |
| `cursor-claude-sonnet-4-7-medium`                    | cursor    | Claude Sonnet 4.7 routed through Cursor            |
| `cursor-default`                                     | cursor    | Cursor "Auto" model                                |
| `cursor-premium` / `cursor-fast` / `cursor-composer` | cursor    | Fallback ids when AvailableModels can't be reached |

Short convenience aliases accepted by codex-providers but omitted from `/v1/models`:

- `fable` -> `claude-fable-5`
- `opus` -> `claude-opus-4-8`
- `opus-5` -> `claude-opus-5`
- `opus-4.8` -> `claude-opus-4-8`
- `sonnet` -> `claude-sonnet-5`
- `haiku` -> `claude-haiku-4-5-20251001`

Claude Code's `[1m]` suffix is accepted on Claude aliases and API IDs (for example `opus[1m]` or `claude-opus-4-8[1m]`). codex-providers strips the suffix before calling Anthropic; current 1M-capable Claude models use the 1M context window by default and do not need the retired `context-1m` beta header.

Routing: requests are dispatched to the matching pool by model name. `claude-*` and the bare aliases (`fable`/`opus`/`opus-4.8`/`sonnet`/`haiku`) hit your Claude account; `gpt-5*`, `o\d` (`o3`, `o4-mini`, …), and `codex-*` hit your Codex account; `deepseek-v4-*` hits DeepSeek; `cursor-*` and `cr/*` hit your Cursor account. Other model families (`gpt-3.5-*`, `gpt-4*`, …) are not served by either backend and route to anthropic by default. If you have not configured the matching provider, the request returns `503 no_account_for_provider` with the required setup in its message.

#### "Cursor exclusive" mode (zero-config Claude Code / OpenAI clients)

When **only Cursor has a logged-in account** (anthropic and codex are both empty), every model name routes to Cursor automatically — `cursor-` prefix becomes optional. This is what makes a Cursor-only codex-providers proxy a drop-in replacement for the Anthropic API or the OpenAI API:

| Client behaviour                                           | What codex-providers does                                                          |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `POST /v1/messages` `{"model":"claude-sonnet-4-5"}`        | routes through Cursor and re-encodes the upstream stream as Anthropic Messages SSE |
| `POST /v1/messages` `{"model":"opus"}`                     | maps `opus` → `claude-opus-4-7-medium` on Cursor, returns Anthropic Messages SSE   |
| `POST /v1/responses` `{"model":"gpt-5.5"}`                 | maps to `gpt-5.5-medium` on Cursor, returns OpenAI Responses SSE                   |
| `POST /v1/chat/completions` `{"model":"claude-haiku-4-5"}` | maps to `claude-4.5-haiku` on Cursor                                               |

A small built-in alias table covers the names Anthropic / OpenAI SDKs and Claude Code use by default (`claude-sonnet-4-5`, `claude-opus-4-7`, `opus`, `sonnet`, `haiku`, `gpt-5.5`, `o3`, …) and translates them to Cursor's internal SKUs (`claude-4.5-sonnet`, `claude-opus-4-7-medium`, `gpt-5.5-medium`, …). Set `CURSOR_MODEL_ALIASES="my-name=claude-opus-4-7-max,foo=composer-2"` to extend the table without forking. Anything not in the table is passed through verbatim, so you can still hit Cursor's full SKU catalogue (e.g. `claude-opus-4-7-thinking-max`).

When **more than one provider has accounts**, the historical routing table above applies — explicit prefixes (`cursor-`, `cr/`) still force Cursor, but `claude-*` goes to your Anthropic OAuth account.

##### Anthropic SSE for Claude Code on Cursor

`POST /v1/messages` against a Cursor-served model emits the Anthropic Messages SSE format (`message_start` → `content_block_start`/`content_block_delta` → `message_delta` → `message_stop`). Reasoning bytes from thinking-enabled models are routed to a `thinking` content block before the final `text` block, matching Claude Code's expectations. Streaming is forced on (Cursor only supports streaming), so non-streaming `/v1/messages` requests still get an SSE response when the upstream is Cursor.

### Endpoint × provider support matrix

| Endpoint                         | anthropic | codex                                                               | cursor                                                             |
| -------------------------------- | --------- | ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `POST /v1/chat/completions`      | ✅        | ✅ (Chat ↔ Responses translator — reasoning as `reasoning_content`) | ✅ (`chat.completion.chunk` SSE; reasoning as `reasoning_content`) |
| `POST /v1/responses`             | ✅        | ✅ (passthrough)                                                    | ✅                                                                 |
| `POST /v1/messages`              | ✅        | ✅ (Anthropic ↔ Responses translator — see below)                   | ✅ (Anthropic Messages SSE — see below)                            |
| `POST /v1/messages/count_tokens` | ✅        | ❌ (501)                                                            | ❌ (501)                                                           |

For Cursor all three OpenAI-compatible endpoints are wired natively: `req.path` selects the wire format the cursor provider emits (`openai-chat-completions`, `openai-responses`, or `anthropic-messages`). Non-streaming `/v1/chat/completions` aggregates the upstream stream into a single `chat.completion` JSON response.

For Codex (ChatGPT-account backend) the same coverage is achieved through a dedicated Chat ↔ Responses ↔ Anthropic translator pair (`src/upstream/responses-translator.ts`): incoming Chat or Anthropic requests are translated to OpenAI Responses upstream, the streaming Responses SSE response is translated back to the original wire format, and non-streaming requests aggregate the SSE locally before responding. Tool calls, system prompts (lifted into `instructions`), `reasoning_effort`/`thinking`, multi-turn conversations and `response_format` `json_schema` are all supported. Codex-specific incompatibilities (`max_output_tokens`, `parallel_tool_calls`) are stripped automatically in the codex handler — you don't have to think about them.

#### Codex `/v1/responses` body requirements

The ChatGPT codex backend rejects requests that don't include `stream: true`, `store: false`, and `instructions`, and 400s on a couple of public Responses fields (`max_output_tokens`, `parallel_tool_calls`). codex-providers applies the same sanitize-and-force-stream pattern to all three codex endpoints (`/v1/chat/completions`, `/v1/messages`, `/v1/responses`):

- `store: false` and `instructions: ""` are auto-filled when the client omits them.
- `max_output_tokens` and `parallel_tool_calls` are stripped — the backend caps tokens by your ChatGPT plan instead.
- The upstream call is **always** made with `stream: true` regardless of the client's `stream` value. If the client asked for `stream: false`, codex-providers drains the upstream SSE locally and returns a single JSON body in the requested wire format (Responses, Chat Completions, or Anthropic Messages) — including stitching `response.output_item.done` items into `output` because codex's `response.completed.response.output` is always `[]`.

Off-the-shelf OpenAI Responses / Chat / Claude Code clients all just work without knowing about codex's quirks.

#### Cursor `/v1/responses` limitations

Cursor's chat protocol is reverse-engineered: requests go to `api2.cursor.sh/aiserver.v1.ChatService/StreamUnifiedChatWithTools` over HTTP/2 + `application/connect+proto`, and the response is decoded back into OpenAI Responses SSE deltas. Stream is forced on (Cursor only supports streaming). Tool calls, images, repository context, edit actions, and Cursor's richer agent protocol are intentionally not translated yet — only single-turn streaming text is supported.

The decoder routes Cursor's chain-of-thought (`reasoning`) bytes to `response.reasoning_summary_text.delta` events instead of leaking them into the main `response.output_text.delta` stream. For Composer/Kimi-style models that stream the entire response (CoT + answer) through a single reasoning channel, the decoder splits on the first `</think>` marker so the final answer still surfaces as plain `output_text`.

### Endpoints

| Endpoint                         | Description                                                           |
| -------------------------------- | --------------------------------------------------------------------- |
| `POST /v1/chat/completions`      | OpenAI-compatible chat                                                |
| `POST /v1/responses`             | OpenAI Responses API compatibility                                    |
| `POST /v1/messages`              | Claude native passthrough                                             |
| `POST /v1/messages/count_tokens` | Claude token counting                                                 |
| `GET /v1/models`                 | List available models                                                 |
| `GET /admin/accounts`            | Account health/status (API key required)                              |
| `GET /admin/stats`               | Per-client / per-account / per-API call statistics (API key required) |
| `POST /admin/reload`             | Reload tokens from disk (API key required)                            |
| `GET /health`                    | Health check                                                          |

## Docker

```bash
# Build
docker build -t codex-providers .

# Run (mount your config and token directory)
docker run -d \
  -p 8317:8317 \
  -v ~/.codex-providers:/data \
  -v ./config.yaml:/config/config.yaml \
  codex-providers
```

Or with docker-compose:

```bash
docker-compose up -d
```

## Use with Claude Code

Set `ANTHROPIC_BASE_URL` to point Claude Code at codex-providers:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8317 \
ANTHROPIC_API_KEY=<your-api-key> \
claude
```

Claude Code uses the native `/v1/messages` endpoint which codex-providers passes through directly. Both `Authorization: Bearer` and `x-api-key` authentication headers are supported.

## Use with Codex

For quick start and non-interactive setup, see [README.md](README.md). `codex-providers` writes the following files:

- `~/.codex/config.toml` — provider block and MultiAgentV2 settings
- `~/.codex/{claude,deepseek}.config.toml` — context with model, fast model, catalog path, context window
- `~/.codex/{claude,deepseek}-models.json` — model catalog with backend-specific `base_instructions` from `docs/prompts/`

### Codex config for sub-agents and cross-provider calls

Codex sub-agent handoff is sensitive to the configured provider identity.
`codex-providers` writes the required provider and MultiAgentV2 settings. For a
Claude parent that can spawn or message GPT/Codex child agents, keep the Claude
profile on a non-OpenAI provider id and run Codex with that generated profile.

In `~/.codex/config.toml`:

```toml
[features.multi_agent_v2]
enabled = true
hide_spawn_agent_metadata = false
max_concurrent_threads_per_session = 8

[model_providers.anthropic]
name = "Claude"
base_url = "http://127.0.0.1:8317/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
stream_idle_timeout_ms = 600000

[model_providers.anthropic.auth]
# Emit the first api key from this repo's config.yaml. Use an absolute node path
# if your shell PATH is not available to Codex.
command = "node"
args = ["-e", "const fs = require('fs'); const yaml = require('js-yaml'); const cfg = yaml.load(fs.readFileSync('/path/to/codex-providers/config.yaml', 'utf8')); const key = cfg?.['api-keys']?.[0]; if (!key) process.exit(1); process.stdout.write(key);"]
cwd = "/path/to/codex-providers"
timeout_ms = 5000
refresh_interval_ms = 300000
```

In `~/.codex/claude.config.toml`:

```toml
model = "claude-opus-4-8"
model_fast = "claude-haiku-4-5-20251001"
model_provider = "anthropic"
model_catalog_json = "/Users/you/.codex/claude-models.json"
model_context_window = 400000
model_auto_compact_token_limit = 360000
```

The important parts are:

- `model_provider = "anthropic"` must match `[model_providers.anthropic]`.
- `wire_api = "responses"` is required for the Codex Claude provider.
- `hide_spawn_agent_metadata = false` is required for reliable multi-agent
  routing and diagnostics.
- `max_concurrent_threads_per_session` controls how many sub-agent threads Codex
  may run concurrently in one session; `codex-providers` asks for this in the
  wizard and defaults to `8` in non-interactive mode.
- Choose a different sub-agent model directly when spawning it; the Claude
  profile continues to use the `anthropic` provider above.

Cross-provider Claude→GPT sub-agent calls also require the apohl79 Codex fork,
or another Codex build with equivalent cross-provider sub-agent support. Older
upstream Codex builds are not sufficient for this setup.

Token budget choices in the wizard:

| Choice                    | `model_context_window` | `model_auto_compact_token_limit` |
| ------------------------- | ---------------------- | -------------------------------- |
| 1M context                | `1000000`              | `900000`                         |
| Recommended context       | `400000`               | `360000`                         |
| Small context             | `200000`               | `180000`                         |
| Tiny context              | `128000`               | `115200`                         |

Reasoning level choices in the wizard (Claude profiles support `max` on adaptive-thinking models; DeepSeek and Gemini retain the first four levels):

| Choice                          | Anthropic thinking budget |
| ------------------------------ | ------------------------- |
| Low reasoning                  | `1024` tokens             |
| Medium reasoning (recommended) | `8192` tokens             |
| High reasoning                 | `24576` tokens            |
| Extra-high reasoning           | `32768` tokens            |
| Maximum reasoning              | Anthropic adaptive `max` |

### System prompts

`codex-providers` reads backend-specific system prompts from `docs/prompts/` and writes them into generated Codex model catalogs:

| File | Backend | Purpose |
| ---- | ------- | ------- |
| `docs/prompts/gpt.md` | OpenAI (GPT) | Used for `gpt-5.6-*` model entries |
| `docs/prompts/claude.md` | Anthropic (Claude) | Used for Claude model entries |
| `docs/prompts/deepseek.md` | DeepSeek | Used for DeepSeek model entries |
| `docs/prompts/gemini.md` | Gemini | Used for Gemini model entries |

The model prompts share the same Codex tool discipline (task completion, autonomy tiers, repository work, destructive action safeguards, git hygiene) but differ in communication style and emphasis:

- **GPT** (`gpt.md`) — Rich personality, collaborative thought-partner tone, CommonMark formatting rules, visualizations guidance.
- **Claude** (`claude.md`) — Outcome-first, terse. No code comments beyond constraint documentation. No backwards-compatibility hacks. Security-conscious (OWASP top 10). Ambitious-task framing.
- **DeepSeek** (`deepseek.md`) — Based on the GPT prompt with a note about no vision/image support and 1M token context window awareness.

Edit the markdown files directly to customize prompts per backend. The files are plain markdown — no template variables or string substitution.

#### Updating the GPT model cache

To sync the `gpt.md` prompt into Codex's cached model definitions for the OpenAI provider:

```bash
codex-providers setup --update-models-cache
```

This reads `docs/prompts/gpt.md` and writes its content into `base_instructions` for all `gpt-5.6-*` model entries in `~/.codex/models_cache.json`, then writes GPT pricing into `~/.codex/config.toml`. A timestamped backup is created before writing.

## Multi-account

codex-providers supports multiple Claude OAuth accounts and Anthropic API-key credentials. Each account is stored as a separate credential file in the auth directory.

- Run `--login` once per account to add tokens
- Requests are routed using sticky selection — the same account is reused until it hits a cooldown
- On rate limit or failure, codex-providers automatically fails over to the next available account
- Per-account token usage (input, output, cache) is tracked and logged periodically
- Use `/admin/accounts` to inspect all account states

## Admin status

Use `/admin/accounts` with your configured API key to inspect the current account states:

```bash
curl http://127.0.0.1:8317/admin/accounts \
  -H "Authorization: Bearer <your-api-key>"
```

Response shape (one entry per logged-in provider):

```json
{
  "providers": {
    "anthropic": { "accounts": [...], "account_count": 1 },
    "codex":     { "accounts": [...], "account_count": 1 }
  },
  "generated_at": "2026-04-26T..."
}
```

Each account snapshot carries availability, cooldown, failure counters, last refresh time, request statistics, and per-account token usage including `totalReasoningOutputTokens` (reasoning models like `gpt-5.5` consume hidden reasoning tokens that aren't part of the visible output). Codex accounts also carry `planType` (e.g. `"plus"` / `"pro"` / `"free"`) extracted from the OAuth `id_token`. If a refresh token was permanently invalidated (`refresh_token_reused`/`expired`/`invalidated`), the account enters a 24-hour terminal cooldown with `lastError` set to a message pointing at `--login --provider=<provider>` for re-authorization.

### Re-authenticating without restart

Running `--login` while the server is up writes a new token file and **automatically notifies the running server** (via `POST /admin/reload`) so the new token takes effect immediately — no restart needed. This is especially important for the codex provider: OpenAI rotates the refresh token on every refresh, so leaving the server running with a stale refresh token while you re-auth would otherwise put the account into a `refresh_token_reused` terminal cooldown.

You can also trigger a reload manually (e.g. on Windows, in containers, or after a `kill -USR1` workflow) by posting to the endpoint:

```bash
curl -X POST http://127.0.0.1:8317/admin/reload \
  -H "Authorization: Bearer <your-api-key>"
```

Response shape:

```json
{
  "reloaded": {
    "anthropic": { "added": [], "updated": ["alice@…"], "unchanged": [] },
    "codex": { "added": [], "updated": [], "unchanged": ["bob@…"] }
  },
  "generated_at": "2026-04-26T..."
}
```

Reload semantics are **upsert only**: new token files on disk are added to the in-memory pool, existing accounts whose `access_token` changed are updated (and any cooldown / `lastError` is cleared, but request/usage stats are preserved), and accounts that no longer exist on disk are kept in memory until the next restart (so historical stats aren't dropped if a token file is accidentally removed).

### Call statistics: `/admin/stats`

Every request that passes API-key auth is appended as a single line to `<auth-dir>/stats.jsonl` and added to an in-memory aggregate. On startup the aggregate is rebuilt by replaying the JSONL, so the snapshot survives restarts.

`GET /admin/stats` returns three independent aggregate views plus a global `totals`:

- `byClient[apiKeyHash]` — keyed by `sha256(api-key)`; tracks requests, success / failure counts, the five token counters, total latency, and the last seen IP / User-Agent.
- `byAccount["<provider>:<email>"]` — keyed by upstream OAuth account.
- `byApi["<endpoint>|<model>|<provider>"]` — keyed by endpoint × model × provider.

```bash
curl http://127.0.0.1:8317/admin/stats \
  -H "Authorization: Bearer <your-api-key>"
```

```json
{
  "byClient": {
    "8f2a1d3c4e5f8f2a1d3c4e5f8f2a1d3c4e5f8f2a1d3c4e5f8f2a1d3c4e5f6789": {
      "apiKeyShort": "8f2a1d3c4e5f",
      "requests": 142, "successes": 140, "failures": 2,
      "totalInputTokens": 12345, "totalOutputTokens": 6789,
      "totalCacheReadInputTokens": 0, "totalLatencyMs": 286430,
      "lastIp": "127.0.0.1", "lastUa": "claude-cli/2.1.88",
      "firstSeenAt": "2026-05-09T08:00:00Z",
      "lastSeenAt":  "2026-05-09T12:00:00Z"
    }
  },
  "byAccount": {
    "anthropic:alice@example.com": { "provider": "anthropic", "email": "alice@example.com", "requests": 100, ... }
  },
  "byApi": {
    "POST /v1/chat/completions|claude-sonnet-5|anthropic": { "endpoint": "POST /v1/chat/completions", "model": "claude-sonnet-5", "provider": "anthropic", "requests": 80, ... }
  },
  "totals": { "requests": 142, "successes": 140, "failures": 2, ... },
  "generated_at": "2026-05-09T12:00:00Z"
}
```

The JSONL grows append-only; if it gets too large just stop the server and delete `stats.jsonl` to reset (the aggregate is flushed on shutdown). To disable stats entirely:

```yaml
stats:
  enabled: false
```

Failure modes of the auto-notify (printed by `--login`):

- `Notified running codex-providers server to reload tokens.` — success, server picked up the new token.
- `(no codex-providers server detected at <host>:<port> — token saved, will be loaded next start)` — connection refused / timeout. Common case when no server is running; not an error.
- `codex-providers server is running but rejected the reload (HTTP 401/403). The api-keys in config.yaml may differ from the running server's; restart the server to pick up the new key set.` — actionable: either edit your config back to match, or restart so the server picks up the new key set.

## Tests

A test suite is included using mocked upstream responses (no real Claude service calls):

```bash
npm run test:smoke
```

## Inspired by

- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
- [sub2api](https://github.com/Wei-Shaw/sub2api)

## License

MIT
