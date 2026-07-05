#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_NAME="${AUTH2API_RUNNER_NAME:-auth2api}"

if [[ -d "$HOME/bin" ]]; then
  BIN_DIR="$HOME/bin"
else
  BIN_DIR="$HOME/.local/bin"
  mkdir -p "$BIN_DIR"
fi

RUNNER_PATH="$BIN_DIR/$RUNNER_NAME"

cat >"$RUNNER_PATH" <<'RUNNER'
#!/usr/bin/env bash
set -euo pipefail

REPO_DIR=__AUTH2API_REPO_DIR__
CONFIG_PATH="${AUTH2API_CONFIG_PATH:-$REPO_DIR/config.yaml}"
LOG_DIR="${AUTH2API_LOG_DIR:-$HOME/.local/state/auth2api}"
PID_FILE="${AUTH2API_PID_FILE:-$LOG_DIR/server.pid}"

usage() {
  cat <<USAGE
Usage: auth2api [ensure|start|--login|<auth2api args>]

Commands:
  ensure   Start auth2api in the background unless its health endpoint is ready.
  start    Run auth2api in the foreground.

All other arguments are passed to node dist/index.js with this repo's config.yaml.

Environment:
  AUTH2API_CONFIG_PATH  Config file path. Default: <repo>/config.yaml
  AUTH2API_LOG_DIR      Background server log directory. Default: ~/.local/state/auth2api
  AUTH2API_PID_FILE     Background server PID file. Default: <log-dir>/server.pid
USAGE
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: required command not found: $1" >&2
    exit 1
  fi
}

read_config_key() {
  local key="$1"
  [[ -f "$CONFIG_PATH" ]] || return 1
  awk -v key="$key" '
    $0 ~ "^[[:space:]]*" key "[[:space:]]*:" {
      sub("^[[:space:]]*" key "[[:space:]]*:[[:space:]]*", "")
      sub("[[:space:]]+#.*$", "")
      gsub("^[ \t\"\047]+|[ \t\"\047]+$", "")
      print
      exit
    }
  ' "$CONFIG_PATH"
}

server_host() {
  local host
  host="$(read_config_key host || true)"
  case "$host" in
    "" | "0.0.0.0" | "::" | "[::]")
      echo "127.0.0.1"
      ;;
    *)
      echo "$host"
      ;;
  esac
}

server_port() {
  local port
  port="$(read_config_key port || true)"
  if [[ -n "$port" ]]; then
    echo "$port"
  else
    echo "8317"
  fi
}

health_url() {
  local host port
  host="$(server_host)"
  port="$(server_port)"
  if [[ "$host" == *:* && "$host" != \[*\] ]]; then
    host="[$host]"
  fi
  printf 'http://%s:%s/health\n' "$host" "$port"
}

is_running() {
  local url="$1"
  curl -fsS --max-time 1 "$url" 2>/dev/null |
    grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"'
}

needs_build() {
  if [[ ! -f "$REPO_DIR/dist/index.js" ]]; then
    return 0
  fi

  find \
    "$REPO_DIR/src" \
    "$REPO_DIR/package.json" \
    "$REPO_DIR/package-lock.json" \
    "$REPO_DIR/tsconfig.json" \
    -type f \
    -newer "$REPO_DIR/dist/index.js" \
    2>/dev/null |
    grep -q .
}

needs_install() {
  if [[ ! -d "$REPO_DIR/node_modules" ]]; then
    return 0
  fi

  if [[ ! -f "$REPO_DIR/node_modules/.package-lock.json" ]]; then
    return 0
  fi

  find \
    "$REPO_DIR/package.json" \
    "$REPO_DIR/package-lock.json" \
    -type f \
    -newer "$REPO_DIR/node_modules/.package-lock.json" \
    2>/dev/null |
    grep -q .
}

ensure_build() {
  require_command node
  require_command npm

  cd "$REPO_DIR"

  if needs_install; then
    npm install
  fi

  if needs_build; then
    npm run build
  fi
}

start_background() {
  require_command node
  mkdir -p "$LOG_DIR"

  local log_file pid
  log_file="$LOG_DIR/server.log"

  cd "$REPO_DIR"
  nohup node "$REPO_DIR/dist/index.js" "--config=$CONFIG_PATH" >>"$log_file" 2>&1 &
  pid="$!"
  printf '%s\n' "$pid" >"$PID_FILE"
  echo "$pid"
}

ensure_server() {
  require_command curl

  local url
  url="$(health_url)"

  if is_running "$url"; then
    echo "auth2api already running at $url"
    return 0
  fi

  ensure_build

  local pid
  pid="$(start_background)"
  echo "Starting auth2api at $url (pid $pid)"

  for _ in $(seq 1 50); do
    if is_running "$url"; then
      echo "auth2api ready at $url"
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "Error: auth2api exited before becoming ready. See $LOG_DIR/server.log" >&2
      return 1
    fi
    sleep 0.2
  done

  echo "Error: auth2api did not become ready. See $LOG_DIR/server.log" >&2
  return 1
}

run_foreground() {
  ensure_build
  cd "$REPO_DIR"
  exec node "$REPO_DIR/dist/index.js" "--config=$CONFIG_PATH" "$@"
}

case "${1:-}" in
  ensure)
    shift
    ensure_server "$@"
    ;;
  start)
    shift
    run_foreground "$@"
    ;;
  -h | --help | help)
    usage
    ;;
  *)
    run_foreground "$@"
    ;;
esac
RUNNER

repo_literal="$(printf '%q' "$SCRIPT_DIR")"
repo_replacement="${repo_literal//\\/\\\\}"
repo_replacement="${repo_replacement//&/\\&}"
repo_replacement="${repo_replacement//|/\\|}"

sed -i.bak "s|__AUTH2API_REPO_DIR__|$repo_replacement|g" "$RUNNER_PATH"
rm -f "$RUNNER_PATH.bak"
chmod 755 "$RUNNER_PATH"

cat <<EOF
Installed auth2api runner: $RUNNER_PATH

Use:
  $RUNNER_PATH ensure

EOF
