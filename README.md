# Codex Providers

Codex Providers connects Codex to Claude (Anthropic), DeepSeek, and Gemini through generated provider profiles and a lightweight local proxy.

This project started as a fork of [auth2api](https://github.com/AmazingAng/auth2api). It now focuses on configuring third-party model providers for the [apohl79 Codex fork](https://github.com/apohl79/codex) and managing the local proxy they use.

## Capabilities

- Interactive Codex provider setup for Claude, DeepSeek, and Gemini
- One local proxy with provider-aware model routing
- Claude OAuth or Anthropic API-key authentication; DeepSeek and Gemini API keys; ChatGPT OAuth; experimental Cursor login
- Generated Codex profiles, model catalogs, and prompts
- OpenAI-compatible Chat Completions, Responses, and Models APIs, plus Anthropic Messages passthrough
- Streaming, tools, images where supported, structured output, multi-account failover, and account statistics

## Supported providers

| Provider | Authentication | Models |
| --- | --- | --- |
| Claude / Anthropic | OAuth or API key | `claude-*` |
| OpenAI Codex | ChatGPT OAuth | `gpt-5*`, `o*`, `codex-*` |
| DeepSeek | API key | `deepseek-*` |
| Google Gemini | API key | `gemini-*` |
| Cursor (experimental) | Browser or local-login import | `cursor-*`, `cr/*` |

## Install and configure

Requires Node.js 20+, npm, Git, and curl.

```bash
curl -fsSL https://raw.githubusercontent.com/apohl79/codex-providers/main/install.sh | bash

# Interactive provider setup (Claude by default)
codex-providers setup
codex -p claude

# Configure a specific provider
codex-providers configure deepseek --yes
codex -p deepseek

codex-providers configure gemini
codex -p gemini
```

The installer keeps its managed source checkout under `~/.local/share/codex-providers` and updates it on subsequent runs.

## Everyday commands

```bash
codex-providers setup
codex-providers configure claude
codex-providers proxy ensure
codex-providers proxy stop
codex-providers proxy logs
codex-providers doctor
```

For direct provider login, proxy configuration, endpoint compatibility, Docker, model catalogs, and operational details, see [README.advanced.md](README.advanced.md).
