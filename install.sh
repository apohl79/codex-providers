#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_NAME="${AUTH2API_RUNNER_NAME:-auth2api}"
ZSHRC_PATH="${AUTH2API_ZSHRC_PATH:-$HOME/.zshrc}"
ZSHRC_BEGIN="# >>> auth2api ensure >>>"
ZSHRC_END="# <<< auth2api ensure <<<"
UNINSTALL=0

usage() {
  cat <<USAGE
Usage: ./install.sh [options]

Installs the auth2api runner and enables auth2api ensure from ~/.zshrc.

Options:
  --uninstall  Remove the installed runner and managed ~/.zshrc ensure block.
  -h, --help   Show this help.

Environment:
  AUTH2API_RUNNER_NAME  Runner name. Default: auth2api
  AUTH2API_ZSHRC_PATH   zshrc path. Default: ~/.zshrc
USAGE
}

while (($#)); do
  case "$1" in
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

if [[ -d "$HOME/bin" ]]; then
  BIN_DIR="$HOME/bin"
else
  BIN_DIR="$HOME/.local/bin"
  mkdir -p "$BIN_DIR"
fi

RUNNER_PATH="$BIN_DIR/$RUNNER_NAME"

runner_paths() {
  printf '%s\n' "$HOME/bin/$RUNNER_NAME" "$HOME/.local/bin/$RUNNER_NAME" |
    awk '!seen[$0]++'
}

remove_zshrc_block() {
  [[ -f "$ZSHRC_PATH" ]] || return 1

  local tmp_path
  tmp_path="$(mktemp)"
  awk -v begin="$ZSHRC_BEGIN" -v end="$ZSHRC_END" '
    $0 == begin { skip = 1; changed = 1; next }
    $0 == end { skip = 0; next }
    !skip { print }
    END { exit changed ? 0 : 1 }
  ' "$ZSHRC_PATH" >"$tmp_path" || {
    rm -f "$tmp_path"
    return 1
  }

  cat "$tmp_path" >"$ZSHRC_PATH"
  rm -f "$tmp_path"
  return 0
}

quote_shell_value() {
  printf '%q' "$1"
}

install_zshrc_block() {
  local quoted_runner_relative_path runner_relative_path zshrc_dir
  zshrc_dir="$(dirname "$ZSHRC_PATH")"
  mkdir -p "$zshrc_dir"

  remove_zshrc_block || true
  runner_relative_path="${RUNNER_PATH#"$HOME"/}"
  quoted_runner_relative_path="$(quote_shell_value "$runner_relative_path")"

  {
    printf '\n%s\n' "$ZSHRC_BEGIN"
    printf 'AUTH2API_RUNNER_PATH="$HOME"/%s\n' "$quoted_runner_relative_path"
    printf '%s\n' "if [[ -x \"\$AUTH2API_RUNNER_PATH\" ]]; then"
    printf '%s\n' "  \"\$AUTH2API_RUNNER_PATH\" ensure >/dev/null 2>&1 || true"
    printf 'fi\n'
    printf 'unset AUTH2API_RUNNER_PATH\n'
    printf '%s\n' "$ZSHRC_END"
  } >>"$ZSHRC_PATH"
}

uninstall() {
  local removed=0 runner_path

  if remove_zshrc_block; then
    echo "Removed auth2api ensure block from $ZSHRC_PATH"
    removed=1
  fi

  while IFS= read -r runner_path; do
    if [[ -e "$runner_path" ]]; then
      rm -f "$runner_path"
      echo "Removed auth2api runner: $runner_path"
      removed=1
    fi
  done < <(runner_paths)

  if [[ "$removed" -eq 0 ]]; then
    echo "No auth2api runner or zshrc ensure block found."
  fi
}

if [[ "$UNINSTALL" -eq 1 ]]; then
  uninstall
  exit 0
fi

cat >"$RUNNER_PATH" <<'RUNNER'
#!/usr/bin/env bash
set -euo pipefail

REPO_DIR=__AUTH2API_REPO_DIR__
CONFIG_PATH="${AUTH2API_CONFIG_PATH:-$REPO_DIR/config.yaml}"
LOG_DIR="${AUTH2API_LOG_DIR:-$HOME/.local/state/auth2api}"
PID_FILE="${AUTH2API_PID_FILE:-$LOG_DIR/server.pid}"

usage() {
  cat <<USAGE
Usage: auth2api [ensure|start|stop|--login|<auth2api args>]

Commands:
  ensure   Start auth2api in the background unless its health endpoint is ready.
  start    Run auth2api in the foreground.
  stop     Stop the background auth2api process started by this runner.

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

is_live_process() {
  local pid state
  pid="$1"
  if ! kill -0 "$pid" 2>/dev/null; then
    return 1
  fi
  state="$(ps -p "$pid" -o stat= 2>/dev/null | tr -d '[:space:]')"
  [[ -n "$state" && "$state" != Z* ]]
}

stop_server() {
  if [[ ! -f "$PID_FILE" ]]; then
    echo "No managed auth2api process found."
    return 0
  fi

  local pid command
  pid="$(tr -d '[:space:]' <"$PID_FILE")"
  if ! [[ "$pid" =~ ^[1-9][0-9]*$ ]] || ! is_live_process "$pid"; then
    rm -f "$PID_FILE"
    echo "Removed stale auth2api PID file."
    return 0
  fi

  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  if [[ "$command" != node\ * && "$command" != */node\ * ]] || \
    [[ "$command" != *"$REPO_DIR/dist/index.js"* ]] || \
    [[ "$command" != *"--config=$CONFIG_PATH"* ]]; then
    echo "Error: refusing to stop PID $pid because it is not this runner's auth2api process." >&2
    return 1
  fi

  kill -TERM "$pid"
  for _ in $(seq 1 50); do
    if ! is_live_process "$pid"; then
      rm -f "$PID_FILE"
      echo "Stopped auth2api (PID $pid)."
      return 0
    fi
    sleep 0.2
  done

  echo "Error: auth2api (PID $pid) did not stop after SIGTERM." >&2
  return 1
}

ensure_server() {
  command -v curl >/dev/null 2>&1 || return 1

  local url
  url="$(health_url)"

  if is_running "$url"; then
    return 0
  fi

  ensure_build >/dev/null 2>&1

  local pid
  pid="$(start_background)"

  for _ in $(seq 1 50); do
    if is_running "$url"; then
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      return 1
    fi
    sleep 0.2
  done

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
  stop)
    shift
    if (($#)); then
      echo "Error: stop does not accept additional arguments." >&2
      exit 2
    fi
    stop_server
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
install_zshrc_block

cat <<EOF
Installed auth2api runner: $RUNNER_PATH
Installed auth2api ensure hook: $ZSHRC_PATH

Use:
  $RUNNER_PATH ensure

Uninstall:
  $SCRIPT_DIR/install.sh --uninstall

EOF
