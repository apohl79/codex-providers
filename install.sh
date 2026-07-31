#!/usr/bin/env bash
set -euo pipefail

SCRIPT_SOURCE="${BASH_SOURCE[0]:-}"
if [[ -n "$SCRIPT_SOURCE" && -f "$SCRIPT_SOURCE" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" && pwd)"
else
  SCRIPT_DIR="$(pwd)"
fi

ORIGINAL_ARGS=("$@")
RUNNER_NAME="${CODEX_PROVIDERS_RUNNER_NAME:-codex-providers}"
ZSHRC_PATH="${CODEX_PROVIDERS_ZSHRC_PATH:-$HOME/.zshrc}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
MANAGED_DIR="${CODEX_PROVIDERS_MANAGED_DIR:-$DATA_HOME/codex-providers}"
REPO_URL="${CODEX_PROVIDERS_REPO_URL:-https://github.com/apohl79/codex-providers.git}"
REPO_BRANCH="${CODEX_PROVIDERS_REPO_BRANCH:-main}"
ZSHRC_BEGIN="# >>> codex-providers proxy ensure >>>"
ZSHRC_END="# <<< codex-providers proxy ensure <<<"
LEGACY_RUNNER_NAME="auth2api"
LEGACY_ZSHRC_BEGIN="# >>> auth2api ensure >>>"
LEGACY_ZSHRC_END="# <<< auth2api ensure <<<"
UNINSTALL=0

usage() {
  cat <<USAGE
Usage: install.sh [options]

Installs codex-providers and enables its proxy ensure hook from ~/.zshrc.

Options:
  --uninstall  Remove codex-providers and its managed ~/.zshrc ensure block.
  -h, --help   Show this help.

Environment:
  CODEX_PROVIDERS_MANAGED_DIR  Source checkout for streamed installs.
                               Default: ~/.local/share/codex-providers
  CODEX_PROVIDERS_REPO_URL     Git repository cloned by streamed installs.
  CODEX_PROVIDERS_REPO_BRANCH  Git branch used by streamed installs. Default: main
  CODEX_PROVIDERS_RUNNER_NAME  Runner name. Default: codex-providers
  CODEX_PROVIDERS_ZSHRC_PATH   zshrc path. Default: ~/.zshrc
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

repository_checkout_is_complete() {
  local repository_dir="$1"
  [[ -f "$repository_dir/install.sh" ]] &&
    [[ -f "$repository_dir/codex-providers" ]] &&
    [[ -f "$repository_dir/package.json" ]] &&
    [[ -d "$repository_dir/src" ]]
}

validate_bootstrap_settings() {
  if [[ -z "$REPO_URL" || "$REPO_URL" == -* ]]; then
    echo "Error: invalid CODEX_PROVIDERS_REPO_URL: $REPO_URL" >&2
    exit 1
  fi
  if [[ ! "$REPO_BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] ||
    [[ "$REPO_BRANCH" == -* ]] ||
    [[ "$REPO_BRANCH" == *".."* ]]; then
    echo "Error: invalid CODEX_PROVIDERS_REPO_BRANCH: $REPO_BRANCH" >&2
    exit 1
  fi
}

bootstrap_managed_checkout() {
  command -v git >/dev/null 2>&1 || {
    echo "Error: git is required for a streamed installation." >&2
    exit 1
  }
  validate_bootstrap_settings

  if [[ -e "$MANAGED_DIR" ]]; then
    if [[ ! -d "$MANAGED_DIR/.git" ]]; then
      echo "Error: managed install path $MANAGED_DIR is not a Git checkout; refusing to overwrite it." >&2
      exit 1
    fi

    local current_url
    current_url="$(git -C "$MANAGED_DIR" remote get-url origin 2>/dev/null || true)"
    if [[ "$current_url" != "$REPO_URL" ]]; then
      echo "Error: managed checkout origin is $current_url, expected $REPO_URL." >&2
      exit 1
    fi

    echo "Updating managed codex-providers checkout: $MANAGED_DIR"
    git -C "$MANAGED_DIR" fetch --quiet origin "$REPO_BRANCH"
    git -C "$MANAGED_DIR" merge --ff-only --quiet FETCH_HEAD
  else
    local managed_parent temporary_checkout
    managed_parent="$(dirname "$MANAGED_DIR")"
    mkdir -p "$managed_parent"
    temporary_checkout="$(mktemp -d "$managed_parent/.codex-providers.XXXXXX")"
    trap 'rm -rf "$temporary_checkout"' EXIT

    echo "Installing managed codex-providers checkout: $MANAGED_DIR"
    git clone --quiet --branch "$REPO_BRANCH" --single-branch "$REPO_URL" "$temporary_checkout"
    mv "$temporary_checkout" "$MANAGED_DIR"
    temporary_checkout=""
    trap - EXIT
  fi

  if ! repository_checkout_is_complete "$MANAGED_DIR"; then
    echo "Error: managed checkout is missing required codex-providers files: $MANAGED_DIR" >&2
    exit 1
  fi

  if (( ${#ORIGINAL_ARGS[@]} )); then
    exec bash "$MANAGED_DIR/install.sh" "${ORIGINAL_ARGS[@]}"
  fi
  exec bash "$MANAGED_DIR/install.sh"
}

if [[ "$UNINSTALL" -eq 0 ]] && ! repository_checkout_is_complete "$SCRIPT_DIR"; then
  bootstrap_managed_checkout
fi

if [[ "$RUNNER_NAME" == "$LEGACY_RUNNER_NAME" ]]; then
  echo "Error: auth2api is no longer a supported runner name; use codex-providers." >&2
  exit 2
fi

if [[ -d "$HOME/bin" ]]; then
  BIN_DIR="$HOME/bin"
else
  BIN_DIR="$HOME/.local/bin"
  mkdir -p "$BIN_DIR"
fi

RUNNER_PATH="$BIN_DIR/$RUNNER_NAME"

runner_paths() {
  local runner_name="$1"
  printf '%s\n' "$HOME/bin/$runner_name" "$HOME/.local/bin/$runner_name" |
    awk '!seen[$0]++'
}

remove_zshrc_block() {
  local begin="$1" end="$2"
  [[ -f "$ZSHRC_PATH" ]] || return 1

  local tmp_path
  tmp_path="$(mktemp)"
  awk -v begin="$begin" -v end="$end" '
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

  remove_zshrc_block "$ZSHRC_BEGIN" "$ZSHRC_END" || true
  runner_relative_path="${RUNNER_PATH#"$HOME"/}"
  quoted_runner_relative_path="$(quote_shell_value "$runner_relative_path")"

  {
    printf '\n%s\n' "$ZSHRC_BEGIN"
    printf 'CODEX_PROVIDERS_RUNNER_PATH="$HOME"/%s\n' "$quoted_runner_relative_path"
    printf '%s\n' "if [[ -x \"\$CODEX_PROVIDERS_RUNNER_PATH\" ]]; then"
    printf '%s\n' "  \"\$CODEX_PROVIDERS_RUNNER_PATH\" proxy ensure >/dev/null 2>&1 || true"
    printf 'fi\n'
    printf 'unset CODEX_PROVIDERS_RUNNER_PATH\n'
    printf '%s\n' "$ZSHRC_END"
  } >>"$ZSHRC_PATH"
}

is_legacy_runner() {
  local runner_path="$1" repo_literal
  repo_literal="$(printf '%q' "$SCRIPT_DIR")"
  [[ -f "$runner_path" ]] && grep -Fq "REPO_DIR=$repo_literal" "$runner_path"
}

remove_legacy_installation() {
  local runner_path

  remove_zshrc_block "$LEGACY_ZSHRC_BEGIN" "$LEGACY_ZSHRC_END" || true

  while IFS= read -r runner_path; do
    if is_legacy_runner "$runner_path"; then
      rm -f "$runner_path"
      echo "Removed legacy auth2api runner: $runner_path"
    fi
  done < <(runner_paths "$LEGACY_RUNNER_NAME")
}

uninstall() {
  local removed=0 runner_path

  if remove_zshrc_block "$ZSHRC_BEGIN" "$ZSHRC_END"; then
    echo "Removed codex-providers proxy ensure block from $ZSHRC_PATH"
    removed=1
  fi

  while IFS= read -r runner_path; do
    if [[ -e "$runner_path" ]]; then
      rm -f "$runner_path"
      echo "Removed codex-providers runner: $runner_path"
      removed=1
    fi
  done < <(runner_paths "$RUNNER_NAME")

  if [[ "$removed" -eq 0 ]]; then
    echo "No codex-providers runner or zshrc proxy ensure block found."
  fi
}

if [[ "$UNINSTALL" -eq 1 ]]; then
  uninstall
  exit 0
fi

remove_legacy_installation

cat >"$RUNNER_PATH" <<'RUNNER'
#!/usr/bin/env bash
set -euo pipefail

REPO_DIR=__CODEX_PROVIDERS_REPO_DIR__
MANAGER_PATH="$REPO_DIR/codex-providers"
CONFIG_PATH="${AUTH2API_CONFIG_PATH:-$REPO_DIR/config.yaml}"
LOG_DIR="${CODEX_PROVIDERS_LOG_DIR:-$HOME/.local/state/codex-providers}"
PID_FILE="${CODEX_PROVIDERS_PID_FILE:-$LOG_DIR/server.pid}"
LEGACY_STATE_DIR="$HOME/.local/state/auth2api"
LEGACY_PID_FILE="$LEGACY_STATE_DIR/server.pid"

usage() {
  cat <<USAGE
Usage: codex-providers <command> [arguments]

Commands:
  setup [args]               Run the interactive provider setup wizard.
  configure <provider> [args]
                             Configure Claude, DeepSeek, or Gemini.
  proxy ensure               Start the local proxy unless its health endpoint is ready.
  proxy start                Run the local proxy in the foreground.
  proxy stop                 Stop the background proxy process started by this runner.
  proxy logs                 Print the background proxy log.
  doctor                     Report whether the local proxy health endpoint is ready.

Run without arguments to start provider setup. Pass setup --help to see wizard options.

Environment:
  AUTH2API_CONFIG_PATH         Proxy config file path. Default: <repo>/config.yaml
  CODEX_PROVIDERS_LOG_DIR      Background proxy log directory. Default: ~/.local/state/codex-providers
  CODEX_PROVIDERS_PID_FILE     Background proxy PID file. Default: <log-dir>/server.pid
  CODEX_PROVIDERS_LOG_LINES    Lines printed by proxy logs. Default: 200
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
  local pid_file="$PID_FILE"
  if [[ ! -f "$pid_file" && "$pid_file" != "$LEGACY_PID_FILE" && -f "$LEGACY_PID_FILE" ]]; then
    pid_file="$LEGACY_PID_FILE"
  fi

  if [[ ! -f "$pid_file" ]]; then
    echo "No managed proxy process found."
    return 0
  fi

  local pid command
  pid="$(tr -d '[:space:]' <"$pid_file")"
  if ! [[ "$pid" =~ ^[1-9][0-9]*$ ]] || ! is_live_process "$pid"; then
    rm -f "$pid_file"
    echo "Removed stale proxy PID file."
    return 0
  fi

  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  if [[ "$command" != node\ * && "$command" != */node\ * ]] || \
    [[ "$command" != *"$REPO_DIR/dist/index.js"* ]] || \
    [[ "$command" != *"--config=$CONFIG_PATH"* ]]; then
    echo "Error: refusing to stop PID $pid because it is not this runner's proxy process." >&2
    return 1
  fi

  kill -TERM "$pid"
  for _ in $(seq 1 50); do
    if ! is_live_process "$pid"; then
      rm -f "$pid_file"
      echo "Stopped proxy (PID $pid)."
      return 0
    fi
    sleep 0.2
  done

  echo "Error: proxy (PID $pid) did not stop after SIGTERM." >&2
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

show_logs() {
  local log_file="$LOG_DIR/server.log"
  if [[ ! -f "$log_file" && -f "$LEGACY_STATE_DIR/server.log" ]]; then
    log_file="$LEGACY_STATE_DIR/server.log"
  fi
  if [[ ! -f "$log_file" ]]; then
    echo "No proxy log file found at $log_file"
    return 0
  fi
  tail -n "${CODEX_PROVIDERS_LOG_LINES:-200}" "$log_file"
}

doctor() {
  require_command curl

  local url
  url="$(health_url)"
  if is_running "$url"; then
    echo "Proxy is healthy: $url"
    return 0
  fi

  echo "Proxy is unavailable: $url" >&2
  return 1
}

run_setup() {
  require_command python3
  exec python3 "$MANAGER_PATH" "$@"
}

run_proxy() {
  local command="${1:-}"
  shift || true

  case "$command" in
    ensure)
      if (($#)); then
        echo "Error: proxy ensure does not accept additional arguments." >&2
        exit 2
      fi
      ensure_server
      ;;
    start)
      run_foreground "$@"
      ;;
    stop)
      if (($#)); then
        echo "Error: proxy stop does not accept additional arguments." >&2
        exit 2
      fi
      stop_server
      ;;
    logs)
      if (($#)); then
        echo "Error: proxy logs does not accept additional arguments." >&2
        exit 2
      fi
      show_logs
      ;;
    "" | -h | --help | help)
      usage
      ;;
    *)
      echo "Error: unknown proxy command: $command" >&2
      usage >&2
      exit 2
      ;;
  esac
}

case "${1:-}" in
  "" | setup)
    if (($#)); then
      shift
    fi
    run_setup "$@"
    ;;
  configure)
    shift
    if (($# == 0)); then
      echo "Error: configure requires a provider." >&2
      usage >&2
      exit 2
    fi
    provider="$1"
    shift
    run_setup --preset "$provider" "$@"
    ;;
  proxy)
    shift
    run_proxy "$@"
    ;;
  doctor)
    shift
    if (($#)); then
      echo "Error: doctor does not accept additional arguments." >&2
      exit 2
    fi
    doctor
    ;;
  -h | --help | help)
    usage
    ;;
  -*)
    run_setup "$@"
    ;;
  *)
    echo "Error: unknown command: $1" >&2
    usage >&2
    exit 2
    ;;
esac
RUNNER

repo_literal="$(printf '%q' "$SCRIPT_DIR")"
repo_replacement="${repo_literal//\\/\\\\}"
repo_replacement="${repo_replacement//&/\\&}"
repo_replacement="${repo_replacement//|/\\|}"

sed -i.bak "s|__CODEX_PROVIDERS_REPO_DIR__|$repo_replacement|g" "$RUNNER_PATH"
rm -f "$RUNNER_PATH.bak"
chmod 755 "$RUNNER_PATH"
install_zshrc_block

cat <<EOF
Installed codex-providers: $RUNNER_PATH
Installed codex-providers proxy ensure hook: $ZSHRC_PATH

Use:
  $RUNNER_PATH setup
  $RUNNER_PATH proxy ensure

Uninstall:
  $SCRIPT_DIR/install.sh --uninstall

EOF
