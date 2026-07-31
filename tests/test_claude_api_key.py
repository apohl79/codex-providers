from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "codex-providers"
LOADER = importlib.machinery.SourceFileLoader("codex_manager", str(MODULE_PATH))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
if SPEC is None:
    raise RuntimeError(f"Could not load {MODULE_PATH}")
codex_manager = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = codex_manager
LOADER.exec_module(codex_manager)


class ClaudeApiKeyLoginTest(unittest.TestCase):
    def _write_claude_credential(self, path: Path, account_uuid: str) -> None:
        path.write_text(json.dumps({"account_uuid": account_uuid}))

    def test_managing_claude_defaults_to_keep_existing_authentication(self) -> None:
        ui = Mock()
        ui.menu.return_value = 0

        with (
            patch.object(codex_manager.curses, "wrapper", side_effect=lambda callback: callback(Mock())),
            patch.object(codex_manager, "CursesUi", return_value=ui),
        ):
            choice = codex_manager.choose_claude_login_action(Path("/tmp/auth"), True)

        self.assertEqual(choice, "keep")
        self.assertEqual(
            [item[0] for item in ui.menu.call_args.args[2]],
            ["Keep existing authentication", "Sign in with Claude", "Use an Anthropic API key", "Abort"],
        )

    def test_api_key_login_launches_anthropic_static_key_flow(self) -> None:
        repo_dir = Path("/tmp/auth2api")
        config_path = repo_dir / "config.yaml"
        expected_command = [
            codex_manager.shutil.which("node") or "node",
            str(repo_dir / "dist" / "index.js"),
            f"--config={config_path}",
            "--login",
            "--provider=anthropic",
            "--auth=api-key",
        ]

        with (
            patch.object(Path, "exists", return_value=True),
            patch.object(codex_manager, "ensure_node_dependencies"),
            patch.object(codex_manager.subprocess, "run") as run,
        ):
            codex_manager.run_claude_api_key_login(repo_dir, config_path)

        run.assert_called_once_with(expected_command, cwd=repo_dir, check=True)

    def test_missing_interactive_claude_credential_can_choose_api_key(self) -> None:
        args = type(
            "Args",
            (),
            {
                "skip_login_check": False,
                "dry_run": False,
                "yes": False,
                "manual_login": False,
            },
        )()
        auth_config = codex_manager.Auth2ApiConfig(
            host="127.0.0.1",
            port=8317,
            auth_dir="~/.codex-providers",
            api_key="local-key",
            deepseek_api_key_env="DEEPSEEK_API_KEY",
        )

        with tempfile.TemporaryDirectory() as directory:
            auth_dir = Path(directory)
            api_key_path = auth_dir / "claude-anthropic-api-key@anthropic_api_key.json"
            with (
                patch.object(codex_manager, "resolve_auth_dir", return_value=auth_dir),
                patch.object(codex_manager, "has_claude_login", side_effect=[False, True]),
                patch.object(codex_manager, "choose_claude_login_action", return_value="api-key"),
                patch.object(
                    codex_manager,
                    "run_claude_api_key_login",
                    side_effect=lambda *_: self._write_claude_credential(api_key_path, "anthropic-api-key"),
                ) as api_key_login,
                patch.object(codex_manager, "run_claude_login") as oauth_login,
            ):
                codex_manager.ensure_backend_login(
                    args,
                    Path("/tmp/auth2api"),
                    Path("/tmp/auth2api/config.yaml"),
                    auth_config,
                    interactive_tty=True,
                    backend=codex_manager.BACKENDS["claude"],
                )

        api_key_login.assert_called_once_with(
            Path("/tmp/auth2api"),
            Path("/tmp/auth2api/config.yaml"),
        )
        oauth_login.assert_not_called()

    def test_api_key_selection_removes_oauth_credentials_and_preserves_malformed_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            auth_dir = Path(directory)
            api_key_path = auth_dir / "claude-anthropic-api-key@anthropic_api_key.json"
            oauth_path = auth_dir / "claude-user@example.com.json"
            malformed_path = auth_dir / "claude-malformed.json"
            self._write_claude_credential(api_key_path, "anthropic-api-key")
            self._write_claude_credential(oauth_path, "oauth-account")
            malformed_path.write_text("not-json")

            backups = codex_manager.remove_opposite_claude_credentials(auth_dir, "api-key")

            self.assertEqual(
                (
                    tuple(sorted(path.name for path in auth_dir.glob("claude-*.json"))),
                    tuple(path.exists() for path in backups),
                ),
                (
                    ("claude-anthropic-api-key@anthropic_api_key.json", "claude-malformed.json"),
                    (True,),
                ),
            )

    def test_oauth_selection_removes_api_key_credential(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            auth_dir = Path(directory)
            api_key_path = auth_dir / "claude-anthropic-api-key@anthropic_api_key.json"
            oauth_path = auth_dir / "claude-user@example.com.json"
            self._write_claude_credential(api_key_path, "anthropic-api-key")
            self._write_claude_credential(oauth_path, "oauth-account")

            backups = codex_manager.remove_opposite_claude_credentials(auth_dir, "oauth")

            self.assertEqual(
                (
                    tuple(path.name for path in auth_dir.glob("claude-*.json")),
                    tuple(path.exists() for path in backups),
                ),
                (("claude-user@example.com.json",), (True,)),
            )

    def test_managing_claude_can_replace_existing_oauth_with_api_key(self) -> None:
        args = type("Args", (), {"skip_login_check": False, "dry_run": False, "yes": False, "manual_login": False})()
        auth_config = codex_manager.Auth2ApiConfig("127.0.0.1", 8317, "~/.codex-providers", "local-key", "DEEPSEEK_API_KEY")

        with tempfile.TemporaryDirectory() as directory:
            auth_dir = Path(directory)
            api_key_path = auth_dir / "claude-anthropic-api-key@anthropic_api_key.json"
            oauth_path = auth_dir / "claude-user@example.com.json"
            self._write_claude_credential(api_key_path, "anthropic-api-key")
            self._write_claude_credential(oauth_path, "oauth-account")
            with (
                patch.object(codex_manager, "resolve_auth_dir", return_value=auth_dir),
                patch.object(codex_manager, "choose_claude_login_action", return_value="api-key") as choice,
                patch.object(codex_manager, "run_claude_api_key_login") as api_key_login,
                patch.object(codex_manager, "run_claude_login") as oauth_login,
            ):
                codex_manager.ensure_backend_login(
                    args, Path("/tmp/auth2api"), Path("/tmp/auth2api/config.yaml"), auth_config,
                    interactive_tty=True, backend=codex_manager.BACKENDS["claude"], prompt_for_claude_auth=True,
                )

            self.assertEqual(
                (
                    choice.call_args.args,
                    api_key_login.call_args.args,
                    oauth_login.call_count,
                    api_key_path.exists(),
                    oauth_path.exists(),
                ),
                (
                    (auth_dir, True),
                    (Path("/tmp/auth2api"), Path("/tmp/auth2api/config.yaml")),
                    0,
                    True,
                    False,
                ),
            )

    def test_managing_claude_can_replace_existing_api_key_with_oauth(self) -> None:
        args = type("Args", (), {"skip_login_check": False, "dry_run": False, "yes": False, "manual_login": False})()
        auth_config = codex_manager.Auth2ApiConfig("127.0.0.1", 8317, "~/.codex-providers", "local-key", "DEEPSEEK_API_KEY")

        with tempfile.TemporaryDirectory() as directory:
            auth_dir = Path(directory)
            api_key_path = auth_dir / "claude-anthropic-api-key@anthropic_api_key.json"
            oauth_path = auth_dir / "claude-user@example.com.json"
            self._write_claude_credential(api_key_path, "anthropic-api-key")
            self._write_claude_credential(oauth_path, "oauth-account")
            with (
                patch.object(codex_manager, "resolve_auth_dir", return_value=auth_dir),
                patch.object(codex_manager, "choose_claude_login_action", return_value="oauth") as choice,
                patch.object(codex_manager, "run_claude_api_key_login") as api_key_login,
                patch.object(codex_manager, "run_claude_login") as oauth_login,
            ):
                codex_manager.ensure_backend_login(
                    args, Path("/tmp/auth2api"), Path("/tmp/auth2api/config.yaml"), auth_config,
                    interactive_tty=True, backend=codex_manager.BACKENDS["claude"], prompt_for_claude_auth=True,
                )

            self.assertEqual(
                (
                    choice.call_args.args,
                    api_key_login.call_count,
                    oauth_login.call_args.args,
                    api_key_path.exists(),
                    oauth_path.exists(),
                ),
                (
                    (auth_dir, True),
                    0,
                    (Path("/tmp/auth2api"), Path("/tmp/auth2api/config.yaml"), False),
                    False,
                    True,
                ),
            )

    def test_managing_claude_can_keep_existing_authentication(self) -> None:
        args = type("Args", (), {"skip_login_check": False, "dry_run": False, "yes": False, "manual_login": False})()
        auth_config = codex_manager.Auth2ApiConfig("127.0.0.1", 8317, "~/.codex-providers", "local-key", "DEEPSEEK_API_KEY")

        with tempfile.TemporaryDirectory() as directory:
            with (
                patch.object(codex_manager, "resolve_auth_dir", return_value=Path(directory)),
                patch.object(codex_manager, "has_claude_login", return_value=True),
                patch.object(codex_manager, "choose_claude_login_action", return_value="keep"),
                patch.object(codex_manager, "run_claude_api_key_login") as api_key_login,
                patch.object(codex_manager, "run_claude_login") as oauth_login,
            ):
                codex_manager.ensure_backend_login(
                    args, Path("/tmp/auth2api"), Path("/tmp/auth2api/config.yaml"), auth_config,
                    interactive_tty=True, backend=codex_manager.BACKENDS["claude"], prompt_for_claude_auth=True,
                )

        api_key_login.assert_not_called()
        oauth_login.assert_not_called()
