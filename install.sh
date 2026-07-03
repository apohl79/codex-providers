#!/usr/bin/env bash
set -euo pipefail

LABEL="${AUTH2API_LAUNCH_LABEL:-com.auth2api.server}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_PATH="${AUTH2API_CONFIG_PATH:-$SCRIPT_DIR/config.yaml}"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/auth2api"
SKIP_TOKEN_CHECK=0
START_SERVICE=1
UNINSTALL=0

usage() {
  cat <<USAGE
Usage: ./install.sh [options]

Installs auth2api as a per-user macOS LaunchAgent.

Options:
  --skip-token-check  Install even if no auth2api OAuth token files are present.
  --no-start          Write the LaunchAgent plist but do not load/start it now.
  --uninstall         Stop and remove the LaunchAgent plist.
  -h, --help          Show this help.

Environment:
  AUTH2API_CONFIG_PATH   Config file path. Default: <repo>/config.yaml
  AUTH2API_LAUNCH_LABEL  LaunchAgent label. Default: com.auth2api.server
USAGE
}

while (($#)); do
  case "$1" in
    --skip-token-check)
      SKIP_TOKEN_CHECK=1
      ;;
    --no-start)
      START_SERVICE=0
      ;;
    --uninstall)
      UNINSTALL=1
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: required command not found: $1" >&2
    exit 1
  fi
}

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  value="${value//\'/&apos;}"
  printf '%s' "$value"
}

resolve_auth_dir() {
  AUTH2API_CONFIG_PATH="$CONFIG_PATH" AUTH2API_REPO_DIR="$SCRIPT_DIR" "$NODE_BIN" <<'NODE'
const fs = require("fs");
const path = require("path");

const repoDir = process.env.AUTH2API_REPO_DIR;
const configPath = process.env.AUTH2API_CONFIG_PATH;
const yaml = require(path.join(repoDir, "node_modules", "js-yaml"));

let authDir = "~/.auth2api";
if (fs.existsSync(configPath)) {
  const parsed = yaml.load(fs.readFileSync(configPath, "utf8")) || {};
  if (typeof parsed["auth-dir"] === "string") authDir = parsed["auth-dir"];
}

const resolved = authDir.startsWith("~")
  ? path.join(process.env.HOME || "", authDir.slice(1))
  : path.isAbsolute(authDir)
    ? authDir
    : path.resolve(repoDir, authDir);

process.stdout.write(resolved);
NODE
}

has_account_files() {
  compgen -G "$AUTH_DIR/claude-*.json" >/dev/null ||
    compgen -G "$AUTH_DIR/codex-*.json" >/dev/null ||
    compgen -G "$AUTH_DIR/cursor-*.json" >/dev/null
}

uninstall() {
  local domain
  domain="gui/$(id -u)"

  if launchctl print "$domain/$LABEL" >/dev/null 2>&1; then
    launchctl bootout "$domain" "$PLIST_PATH" >/dev/null 2>&1 || true
  fi

  rm -f "$PLIST_PATH"
  echo "Removed LaunchAgent: $PLIST_PATH"
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Error: LaunchAgents are only supported on macOS." >&2
  exit 1
fi

if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  echo "Error: run this installer as your user, not with sudo." >&2
  exit 1
fi

require_command launchctl

if [[ "$UNINSTALL" -eq 1 ]]; then
  uninstall
  exit 0
fi

require_command node
require_command npm
require_command plutil

NODE_BIN="$(node -p 'process.execPath')"

cd "$SCRIPT_DIR"

echo "Installing dependencies..."
npm install

echo "Building auth2api..."
npm run build

if [[ ! -f "$SCRIPT_DIR/dist/index.js" ]]; then
  echo "Error: build did not produce dist/index.js" >&2
  exit 1
fi

AUTH_DIR="$(resolve_auth_dir)"

if [[ "$SKIP_TOKEN_CHECK" -eq 0 ]] && ! has_account_files; then
  cat >&2 <<ERROR
Error: no auth2api account token files found in $AUTH_DIR.

Run a login first, for example:
  node dist/index.js --login --provider=codex

Then run ./install.sh again. To install before logging in, pass --skip-token-check.
ERROR
  exit 1
fi

mkdir -p "$PLIST_DIR" "$LOG_DIR"

cat >"$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$NODE_BIN")</string>
    <string>$(xml_escape "$SCRIPT_DIR/dist/index.js")</string>
    <string>--config=$(xml_escape "$CONFIG_PATH")</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$SCRIPT_DIR")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$LOG_DIR/server.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$LOG_DIR/server.err.log")</string>
</dict>
</plist>
PLIST

plutil -lint "$PLIST_PATH" >/dev/null

if [[ "$START_SERVICE" -eq 1 ]]; then
  DOMAIN="gui/$(id -u)"
  launchctl bootout "$DOMAIN" "$PLIST_PATH" >/dev/null 2>&1 || true
  launchctl bootstrap "$DOMAIN" "$PLIST_PATH"
  launchctl enable "$DOMAIN/$LABEL"
  launchctl kickstart -k "$DOMAIN/$LABEL"

  echo "Installed and started LaunchAgent: $PLIST_PATH"
  echo "Logs: $LOG_DIR/server.log and $LOG_DIR/server.err.log"
else
  echo "Installed LaunchAgent: $PLIST_PATH"
  echo "Not started because --no-start was provided."
fi
