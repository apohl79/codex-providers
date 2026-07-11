from __future__ import annotations

import importlib.machinery
import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import call, patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "codex-manager"
LOADER = importlib.machinery.SourceFileLoader("codex_manager", str(MODULE_PATH))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
if SPEC is None:
    raise RuntimeError(f"Could not load {MODULE_PATH}")
codex_manager = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = codex_manager
LOADER.exec_module(codex_manager)


class EnsureNodeDependenciesTest(unittest.TestCase):
    def test_skips_install_when_dependency_tree_is_complete(self) -> None:
        repo_dir = Path("/tmp/auth2api")

        with patch.object(codex_manager.subprocess, "run") as run:
            run.return_value = subprocess.CompletedProcess([], 0)

            codex_manager.ensure_node_dependencies(repo_dir)

        run.assert_called_once_with(
            ["npm", "ls", "--depth=0"],
            cwd=repo_dir,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )

    def test_installs_when_dependency_tree_is_incomplete(self) -> None:
        repo_dir = Path("/tmp/auth2api")

        with patch.object(codex_manager.subprocess, "run") as run:
            run.side_effect = [
                subprocess.CompletedProcess([], 1),
                subprocess.CompletedProcess([], 0),
            ]

            codex_manager.ensure_node_dependencies(repo_dir)

        self.assertEqual(
            run.call_args_list,
            [
                call(
                    ["npm", "ls", "--depth=0"],
                    cwd=repo_dir,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                ),
                call(["npm", "install"], cwd=repo_dir, check=True),
            ],
        )


class RunClaudeLoginTest(unittest.TestCase):
    def test_checks_dependencies_before_launching_login(self) -> None:
        repo_dir = Path("/tmp/auth2api")
        config_path = repo_dir / "config.yaml"
        expected_command = [
            codex_manager.shutil.which("node") or "node",
            str(repo_dir / "dist" / "index.js"),
            f"--config={config_path}",
            "--login",
            "--provider=anthropic",
        ]

        with (
            patch.object(Path, "exists", return_value=True),
            patch.object(codex_manager, "ensure_node_dependencies") as ensure_dependencies,
            patch.object(codex_manager.subprocess, "run") as run,
        ):
            codex_manager.run_claude_login(repo_dir, config_path, manual=False)

        ensure_dependencies.assert_called_once_with(repo_dir)
        run.assert_called_once_with(expected_command, cwd=repo_dir, check=True)


class DeepSeekBackendTest(unittest.TestCase):
    def _args(self, *, yes: bool = True) -> object:
        return type(
            "Args",
            (),
            {
                "skip_login_check": False,
                "dry_run": False,
                "yes": yes,
                "manual_login": False,
            },
        )()

    def test_read_config_parses_deepseek_api_key_environment_name(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "config.yaml"
            config_path.write_text(
                "auth-dir: ~/.auth2api\n"
                "deepseek:\n"
                "  api-key-env: CUSTOM_DEEPSEEK_KEY\n"
                "  base-url: https://api.deepseek.com/anthropic\n"
            )
            config = codex_manager.read_auth2api_config(config_path)

        self.assertEqual(config.deepseek_api_key_env, "CUSTOM_DEEPSEEK_KEY")

    def test_deepseek_backend_filters_models_and_uses_flash_fast_model(self) -> None:
        backend = codex_manager.BACKENDS["deepseek"]

        self.assertEqual(backend.default_provider, "deepseek")
        self.assertEqual(
            codex_manager.filter_models(
                ["deepseek-v4-pro", "deepseek-v4-flash", "claude-sonnet-5"],
                backend,
            ),
            ["deepseek-v4-pro", "deepseek-v4-flash"],
        )
        self.assertEqual(codex_manager.fast_model_for_backend(backend), "deepseek-v4-flash")

    def test_run_deepseek_login_uses_api_key_provider(self) -> None:
        repo_dir = Path("/tmp/auth2api")
        config_path = repo_dir / "config.yaml"
        expected_command = [
            codex_manager.shutil.which("node") or "node",
            str(repo_dir / "dist" / "index.js"),
            f"--config={config_path}",
            "--login",
            "--provider=deepseek",
        ]

        with (
            patch.object(Path, "exists", return_value=True),
            patch.object(codex_manager, "ensure_node_dependencies"),
            patch.object(codex_manager.subprocess, "run") as run,
        ):
            codex_manager.run_deepseek_login(repo_dir, config_path)

        run.assert_called_once_with(expected_command, cwd=repo_dir, check=True)

    def test_deepseek_preset_does_not_enforce_claude_login(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            auth_dir = Path(directory)
            auth_config = codex_manager.Auth2ApiConfig(
                host="127.0.0.1",
                port=8317,
                auth_dir=str(auth_dir),
                api_key="local-key",
                deepseek_api_key_env="DEEPSEEK_API_KEY",
            )
            with (
                patch.dict(codex_manager.os.environ, {"DEEPSEEK_API_KEY": "configured"}),
                patch.object(codex_manager, "run_claude_login") as claude_login,
                patch.object(codex_manager, "run_deepseek_login") as deepseek_login,
            ):
                codex_manager.ensure_backend_login(
                    self._args(),
                    Path("/tmp/auth2api"),
                    Path("/tmp/auth2api/config.yaml"),
                    auth_config,
                    interactive_tty=False,
                    backend=codex_manager.BACKENDS["deepseek"],
                )

            claude_login.assert_not_called()
            deepseek_login.assert_not_called()

    def test_missing_deepseek_credential_starts_deepseek_login(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            auth_config = codex_manager.Auth2ApiConfig(
                host="127.0.0.1",
                port=8317,
                auth_dir=directory,
                api_key="local-key",
                deepseek_api_key_env="DEEPSEEK_API_KEY",
            )
            with (
                patch.dict(codex_manager.os.environ, {}, clear=True),
                patch.object(codex_manager, "has_deepseek_login", side_effect=[False, True]),
                patch.object(codex_manager, "run_claude_login") as claude_login,
                patch.object(codex_manager, "run_deepseek_login") as deepseek_login,
            ):
                codex_manager.ensure_backend_login(
                    self._args(),
                    Path("/tmp/auth2api"),
                    Path("/tmp/auth2api/config.yaml"),
                    auth_config,
                    interactive_tty=True,
                    backend=codex_manager.BACKENDS["deepseek"],
                )

            claude_login.assert_not_called()
            deepseek_login.assert_called_once_with(
                Path("/tmp/auth2api"),
                Path("/tmp/auth2api/config.yaml"),
            )

    def test_noninteractive_draft_generates_deepseek_context(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            codex_home = root / "codex"
            codex_home.mkdir()
            args = type(
                "Args",
                (),
                {
                    "preset": "deepseek",
                    "models": None,
                    "model": None,
                    "reasoning_level": None,
                    "context_window": None,
                    "compact_limit": None,
                    "max_concurrent_threads_per_session": None,
                    "source_context": None,
                    "display_name": None,
                    "dry_run": True,
                },
            )()

            with patch.object(
                codex_manager,
                "fetch_models",
                return_value=(
                    ["deepseek-v4-pro", "deepseek-v4-flash"],
                    "test models",
                ),
            ):
                draft, _ = codex_manager.noninteractive_draft(
                    args,
                    codex_home,
                    root / "config.toml",
                    root / "config.yaml",
                )

            self.assertEqual(draft.provider_id, "deepseek")
            self.assertEqual(draft.context_name, "deepseek")
            self.assertEqual(draft.default_model, "deepseek-v4-pro")
            self.assertEqual(draft.fast_model, "deepseek-v4-flash")
            self.assertEqual(draft.catalog_path, codex_home / "deepseek-models.json")
            self.assertIn('service_tier = "default"', codex_manager.context_content(draft))
            provider = codex_manager.provider_block(draft, root, root / "config.yaml")
            self.assertIn("[model_providers.deepseek]", provider)

    def test_deepseek_catalog_contains_required_codex_model_fields(self) -> None:
        catalog = codex_manager.build_catalog(
            ("deepseek-v4-pro",),
            codex_manager.BACKENDS["deepseek"],
            {"models": []},
            400000,
            "medium",
        )
        model = catalog["models"][0]
        for field in (
            "shell_type",
            "base_instructions",
            "supports_reasoning_summaries",
            "truncation_policy",
            "experimental_supported_tools",
        ):
            self.assertIn(field, model)
        self.assertEqual(model["shell_type"], "shell_command")
        self.assertEqual(model["truncation_policy"], {"mode": "tokens", "limit": 10000})

    def test_deepseek_catalog_uses_direct_tools_for_anthropic_bridge(self) -> None:
        catalog = codex_manager.build_catalog(
            ("deepseek-v4-pro",),
            codex_manager.BACKENDS["deepseek"],
            {"models": []},
            400000,
            "medium",
        )

        self.assertEqual(catalog["models"][0]["tool_mode"], "direct")


class ProviderMenuTest(unittest.TestCase):
    class FakeUi:
        def __init__(self, selections: list[int]) -> None:
            self.selections = iter(selections)
            self.calls: list[tuple[str, list[codex_manager.MenuItem]]] = []

        def menu(self, title: str, subtitle: str, items: list[codex_manager.MenuItem], default: int = 0) -> int:
            self.calls.append((title, items))
            return next(self.selections)

    def test_add_menu_disables_configured_provider(self) -> None:
        ui = self.FakeUi([0, 1])

        selection = codex_manager.choose_provider_action(ui, {"claude"})

        self.assertEqual(selection, ("add", "deepseek"))
        add_items = ui.calls[1][1]
        self.assertEqual(add_items[0][2], False)
        self.assertEqual(add_items[1][2], True)

    def test_menu_item_parts_accepts_enabled_metadata(self) -> None:
        self.assertEqual(
            codex_manager.menu_item_parts(("Claude", "configured", False)),
            ("Claude", "configured", False),
        )
        self.assertEqual(
            codex_manager.menu_item_parts(("Abort", "Exit")),
            ("Abort", "Exit", True),
        )

    def test_add_menu_is_disabled_when_both_providers_are_configured(self) -> None:
        ui = self.FakeUi([1, 0])

        selection = codex_manager.choose_provider_action(ui, {"claude", "deepseek"})

        self.assertEqual(selection, ("manage", "claude"))
        manager_items = ui.calls[1][1]
        self.assertEqual([item[0] for item in manager_items], ["Claude", "DeepSeek", "Abort"])
        top_items = ui.calls[0][1]
        self.assertEqual(top_items[0][2], False)
        self.assertEqual(top_items[1][2], True)

    def test_context_budget_choices_are_provider_neutral(self) -> None:
        choices = codex_manager.context_budget_choices()

        self.assertEqual(
            [label for label, _ in choices],
            ["Keep current limits", "1M context", "Recommended context", "Small context", "Tiny context"],
        )
        self.assertFalse(any("Claude" in text for item in choices for text in item))


if __name__ == "__main__":
    unittest.main()
