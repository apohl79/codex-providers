from __future__ import annotations

import importlib.machinery
import importlib.util
import io
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import call, patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "codex-providers"
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
                "auth-dir: ~/.custom-auth-dir\n"
                "deepseek:\n"
                "  api-key-env: CUSTOM_DEEPSEEK_KEY\n"
                "  base-url: https://api.deepseek.com/anthropic\n"
            )
            config = codex_manager.read_auth2api_config(config_path)

        self.assertEqual(
            (config.auth_dir, config.deepseek_api_key_env),
            ("~/.custom-auth-dir", "CUSTOM_DEEPSEEK_KEY"),
        )

    def test_deepseek_backend_requests_its_catalog_and_uses_flash_fast_model(self) -> None:
        backend = codex_manager.BACKENDS["deepseek"]

        self.assertEqual(backend.default_provider, "deepseek")
        with patch.object(codex_manager.urllib.request, "urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value.read.return_value = (
                b'{"data":[{"id":"deepseek-v4-pro"},{"id":"custom-model"},{"id":"deepseek-v4-pro"}]}'
            )
            models, _ = codex_manager.fetch_models("http://127.0.0.1:8317/v1", "local-key", backend)

        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:8317/v1/models?provider=deepseek")
        self.assertEqual(models, ["deepseek-v4-pro", "custom-model", "deepseek-v4-flash"])
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
            self.assertIn("namespace_tools = false", provider)
            self.assertIn('query_params = { provider = "deepseek" }', provider)

            claude_provider = codex_manager.provider_block(
                codex_manager.replace(
                    draft,
                    provider_id="anthropic",
                    display_name="Claude",
                    backend=codex_manager.BACKENDS["claude"],
                ),
                root,
                root / "config.yaml",
            )
            self.assertIn("namespace_tools = false", claude_provider)
            self.assertIn('query_params = { provider = "anthropic" }', claude_provider)

    def test_deepseek_catalog_contains_required_codex_model_fields(self) -> None:
        catalog = codex_manager.build_catalog(
            ("deepseek-v4-pro",),
            codex_manager.BACKENDS["deepseek"],
            {"models": [{"slug": "deepseek-v4-pro", "tool_mode": "code_mode_only"}]},
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

    def test_claude_catalog_uses_direct_tools_for_anthropic_bridge(self) -> None:
        catalog = codex_manager.build_catalog(
            ("claude-opus-4-8",),
            codex_manager.BACKENDS["claude"],
            {"models": [{"slug": "claude-opus-4-8", "tool_mode": "code_mode_only"}]},
            400000,
            "medium",
        )

        self.assertEqual(catalog["models"][0]["tool_mode"], "direct")


class CredentialDirectoryDefaultTest(unittest.TestCase):
    def test_missing_config_uses_codex_providers_credential_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = codex_manager.read_auth2api_config(Path(directory) / "missing.yaml")

        self.assertEqual(config.auth_dir, "~/.codex-providers")


class ClaudeOpus5SupportTest(unittest.TestCase):
    def test_claude_fallback_and_alias_include_opus_5(self) -> None:
        backend = codex_manager.BACKENDS["claude"]

        self.assertEqual(backend.fallback_models[0], "claude-opus-5")
        self.assertEqual(codex_manager.canonical_model("opus-5"), "claude-opus-5")

    def test_claude_haiku_alias_normalizes_to_the_canonical_model(self) -> None:
        models = codex_manager.normalize_models(
            ["claude-haiku-4-5-20251001", "claude-haiku-4-5"]
        )

        self.assertEqual(models, ["claude-haiku-4-5-20251001"])

    def test_claude_opus_5_uses_current_anthropic_token_prices(self) -> None:
        self.assertEqual(
            codex_manager._claude_model_prices()["claude-opus-5"],
            {"input": 5.0, "cached_input": 0.50, "output": 25.0},
        )

    def test_adaptive_claude_catalog_exposes_max_reasoning(self) -> None:
        catalog = codex_manager.build_catalog(
            ("claude-opus-4-8",),
            codex_manager.BACKENDS["claude"],
            {"models": []},
            400000,
            "max",
        )
        model = catalog["models"][0]

        self.assertEqual(model["default_reasoning_level"], "max")
        self.assertEqual(
            [level["effort"] for level in model["supported_reasoning_levels"]],
            ["low", "medium", "high", "xhigh", "max"],
        )

    def test_legacy_claude_catalog_does_not_expose_max_reasoning(self) -> None:
        catalog = codex_manager.build_catalog(
            ("claude-haiku-4-5-20251001",),
            codex_manager.BACKENDS["claude"],
            {"models": []},
            400000,
            "max",
        )
        model = catalog["models"][0]

        self.assertEqual(model["default_reasoning_level"], "medium")
        self.assertNotIn(
            "max",
            [level["effort"] for level in model["supported_reasoning_levels"]],
        )

    def test_non_claude_catalog_does_not_expose_max_reasoning(self) -> None:
        catalog = codex_manager.build_catalog(
            ("deepseek-v4-pro",),
            codex_manager.BACKENDS["deepseek"],
            {"models": []},
            400000,
            "max",
        )
        model = catalog["models"][0]

        self.assertEqual(model["default_reasoning_level"], "medium")
        self.assertNotIn(
            "max",
            [level["effort"] for level in model["supported_reasoning_levels"]],
        )


class GeminiProxyBackendTest(unittest.TestCase):
    def test_gemini_backend_uses_google_for_codex_and_auth2api(self) -> None:
        backend = codex_manager.BACKENDS["gemini"]

        self.assertEqual(
            (backend.default_provider, backend.auth2api_provider, backend.provider_aliases),
            ("google", "google", ("google", "gemini", "local-gemini")),
        )

    def test_gemini_catalog_upgrades_text_only_source_for_image_input(self) -> None:
        catalog = codex_manager.build_catalog(
            ("gemini-3.6-flash",),
            codex_manager.BACKENDS["gemini"],
            {"models": [{"slug": "gemini-3.6-flash", "input_modalities": ["text"]}]},
            400000,
            "medium",
        )

        self.assertEqual(catalog["models"][0]["input_modalities"], ["text", "image"])

    def test_fetch_models_uses_auth2api_key(self) -> None:
        backend = codex_manager.BACKENDS["gemini"]

        with (
            patch.object(codex_manager.urllib.request, "urlopen") as urlopen,
        ):
            urlopen.return_value.__enter__.return_value.read.return_value = b'{"data": [{"id": "gemini-3.6-flash"}]}'
            models, _ = codex_manager.fetch_models("https://example.test/v1", "auth2api-key", backend)

        request = urlopen.call_args.args[0]
        self.assertEqual(
            (
                models,
                request.full_url,
                request.get_header("X-goog-api-key"),
                request.get_header("Authorization"),
                request.get_header("X-api-key"),
            ),
            (
                [
                    "gemini-3.6-flash",
                    "gemini-3.5-flash",
                    "gemini-3.1-pro-preview",
                    "gemini-3-pro-preview",
                ],
                "https://example.test/v1/models?provider=google",
                None,
                "Bearer auth2api-key",
                "auth2api-key",
            ),
        )

    def test_gemini_prompt_identifies_gemini(self) -> None:
        self.assertEqual(
            codex_manager.load_prompt(MODULE_PATH.parent, "gemini").splitlines()[0],
            "You are Codex, an agent based on Gemini. You and the user share one workspace, and your job is to collaborate with them until their goal is genuinely handled.",
        )

    def test_gemini_main_creates_an_auth2api_key(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            auth2api_config = root / "config.yaml"
            codex_home = root / "codex"
            args = type(
                "Args",
                (),
                {
                    "update_models_cache": False,
                    "codex_home": str(codex_home),
                    "codex_config": str(codex_home / "config.toml"),
                    "auth2api_config": str(auth2api_config),
                    "source_context": None,
                    "preset_explicit": True,
                    "yes": True,
                    "preset": "gemini",
                    "dry_run": True,
                    "skip_login_check": False,
                    "manual_login": False,
                },
            )()
            draft = codex_manager.Draft(
                "gemini",
                codex_home / "gemini.config.toml",
                "gemini",
                "Gemini",
                codex_manager.BACKENDS["gemini"],
                "http://127.0.0.1:8317/v1",
                ("gemini-3.6-flash",),
                "gemini-3.6-flash",
                "gemini-3.6-flash",
                "medium",
                400000,
                360000,
                8,
                codex_home / "gemini-models.json",
                True,
            )

            with (
                patch.dict(codex_manager.os.environ, {"GEMINI_API_KEY": "gemini-key"}),
                patch.object(codex_manager, "parse_args", return_value=args),
                patch.object(
                    codex_manager,
                    "ensure_api_key",
                    return_value=(
                        codex_manager.Auth2ApiConfig(
                            "127.0.0.1",
                            8317,
                            "~/.codex-providers",
                            "auth2api-key",
                            "DEEPSEEK_API_KEY",
                        ),
                        [],
                        True,
                    ),
                ) as ensure_api_key,
                patch.object(codex_manager, "noninteractive_draft", return_value=(draft, {})),
                patch.object(codex_manager, "agent_definitions", return_value=()),
            ):
                result = codex_manager.main()

            self.assertEqual((result, ensure_api_key.call_args.args, auth2api_config.exists()), (0, (auth2api_config, True), False))

    def test_missing_gemini_login_runs_auth2api_login(self) -> None:
        args = type("Args", (), {"skip_login_check": False, "dry_run": False, "yes": False, "manual_login": False})()

        with tempfile.TemporaryDirectory() as directory:
            with (
                patch.dict(codex_manager.os.environ, {}, clear=True),
                patch.object(codex_manager, "has_google_login", side_effect=[False, True]),
                patch.object(codex_manager, "run_google_login") as google_login,
            ):
                codex_manager.ensure_backend_login(
                    args,
                    Path("/tmp/auth2api"),
                    Path("/tmp/auth2api/config.yaml"),
                    codex_manager.Auth2ApiConfig("127.0.0.1", 8317, directory, "local-key", "DEEPSEEK_API_KEY"),
                    interactive_tty=True,
                    backend=codex_manager.BACKENDS["gemini"],
                )

            google_login.assert_called_once_with(Path("/tmp/auth2api"), Path("/tmp/auth2api/config.yaml"))

    def test_gemini_provider_block_targets_auth2api_responses_endpoint(self) -> None:
        draft = codex_manager.Draft(
            "gemini", Path("/tmp/gemini.toml"), "google", "Gemini", codex_manager.BACKENDS["gemini"],
            "http://127.0.0.1:8317/v1", ("gemini-3.6-flash",), "gemini-3.6-flash", "gemini-3.6-flash",
            "medium", 400000, 360000, 8, Path("/tmp/gemini-models.json"), False,
        )

        provider = codex_manager.provider_block(draft, Path("/tmp/auth2api"), Path("/tmp/auth2api/config.yaml"))

        self.assertEqual(
            (
                "base_url = \"http://127.0.0.1:8317/v1\"" in provider,
                "query_params = { provider = \"google\" }" in provider,
                "wire_api = \"responses\"" in provider,
                "generativelanguage.googleapis.com" in provider,
                "[model_providers.google]" in provider,
            ),
            (True, True, True, False, True),
        )

    def test_write_files_migrates_gemini_context_to_google_provider(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config_path = root / "config.toml"
            context_path = root / "gemini.config.toml"
            auth2api_config_path = root / "auth2api.yaml"
            config_path.write_text('[model_providers.gemini]\nname = "Gemini"\n\n[model_providers.gemini.auth]\ncommand = "node"\n')
            draft = codex_manager.Draft(
                "gemini", context_path, "google", "Gemini", codex_manager.BACKENDS["gemini"],
                "http://127.0.0.1:8317/v1", ("gemini-3.6-flash",), "gemini-3.6-flash", "gemini-3.6-flash",
                "medium", 400000, 360000, 8, root / "gemini-models.json", False,
            )

            codex_manager.write_files(
                draft, config_path, MODULE_PATH.parent, auth2api_config_path, {"models": []}
            )
            provider_data = codex_manager.tomllib.loads(config_path.read_text())["model_providers"]

            self.assertEqual(
                (
                    codex_manager.tomllib.loads(context_path.read_text())["model_provider"],
                    sorted(provider_data),
                    provider_data["google"]["query_params"],
                    auth2api_config_path.read_text(),
                ),
                (
                    "google",
                    ["google"],
                    {"provider": "google"},
                    'model-advertisements:\n  google:\n    - "gemini-3.6-flash"\n',
                ),
            )


class ModelAdvertisementConfigTest(unittest.TestCase):
    def test_upsert_model_advertisements_replaces_only_the_selected_provider(self) -> None:
        updated = codex_manager.upsert_model_advertisements(
            "port: 8317\nmodel-advertisements:\n  deepseek:\n    - deepseek-v4-pro\nstats:\n  enabled: true\n",
            "anthropic",
            ("claude-opus-5", "claude-sonnet-5"),
        )

        self.assertEqual(
            updated,
            "port: 8317\nmodel-advertisements:\n  deepseek:\n    - deepseek-v4-pro\n  anthropic:\n    - \"claude-opus-5\"\n    - \"claude-sonnet-5\"\nstats:\n  enabled: true\n",
        )


class ProviderMenuTest(unittest.TestCase):
    class FakeUi:
        def __init__(self, selections: list[int]) -> None:
            self.selections = iter(selections)
            self.calls: list[tuple[str, list[codex_manager.MenuItem]]] = []

        def menu(self, title: str, subtitle: str, items: list[codex_manager.MenuItem], default: int = 0) -> int:
            self.calls.append((title, items))
            return next(self.selections)

    def test_add_menu_enables_unconfigured_gemini_provider(self) -> None:
        ui = self.FakeUi([0, 2])

        selection = codex_manager.choose_provider_action(ui, {"claude", "deepseek"})

        self.assertEqual(selection, ("add", "gemini"))
        add_items = ui.calls[1][1]
        self.assertEqual(
            [(item[0], codex_manager.menu_item_parts(item)[2]) for item in add_items],
            [("Claude", False), ("DeepSeek", False), ("Gemini", True), ("Abort", True)],
        )

    def test_gemini_credential_does_not_count_as_a_configured_profile(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch.dict(codex_manager.os.environ, {"GEMINI_API_KEY": "gemini-key"}, clear=True):
            codex_home = Path(directory)
            (codex_home / "config.toml").write_text("[model_providers.anthropic]\n[model_providers.deepseek]\n")
            configured = codex_manager.configured_backends(codex_home, codex_home / "config.toml")
        self.assertEqual(configured, {"claude", "deepseek"})

    def test_menu_item_parts_accepts_enabled_metadata(self) -> None:
        self.assertEqual(
            codex_manager.menu_item_parts(("Claude", "configured", False)),
            ("Claude", "configured", False),
        )
        self.assertEqual(
            codex_manager.menu_item_parts(("Abort", "Exit")),
            ("Abort", "Exit", True),
        )

    def test_add_menu_is_disabled_when_all_providers_are_configured(self) -> None:
        ui = self.FakeUi([1, 0])

        selection = codex_manager.choose_provider_action(ui, {"claude", "deepseek", "gemini"})

        self.assertEqual(selection, ("manage", "claude"))
        manager_items = ui.calls[1][1]
        self.assertEqual([item[0] for item in manager_items], ["Claude", "DeepSeek", "Gemini", "Abort"])
        top_items = ui.calls[0][1]
        self.assertEqual(top_items[0][2], False)
        self.assertEqual(top_items[1][2], True)

    def test_context_budget_choices_are_provider_neutral(self) -> None:
        choices = codex_manager.context_budget_choices()

        self.assertEqual(
            choices,
            [
                ("Keep current limits", "Context window: {context_window} tokens. Auto-compact threshold: {compact_limit} tokens."),
                ("1M context", "Context window: 1000000 tokens. Auto-compact threshold: 900000 tokens."),
                ("Recommended context", "Context window: 400000 tokens. Auto-compact threshold: 360000 tokens."),
                ("Small context", "Context window: 200000 tokens. Auto-compact threshold: 180000 tokens."),
                ("Tiny context", "Context window: 128000 tokens. Auto-compact threshold: 115200 tokens."),
            ],
        )


class CommandLineIdentityTest(unittest.TestCase):
    def test_help_uses_the_codex_providers_command_name(self) -> None:
        output = io.StringIO()
        with (
            patch.object(sys, "argv", ["codex-providers", "--help"]),
            patch.object(sys, "stdout", output),
            self.assertRaises(SystemExit) as error,
        ):
            codex_manager.parse_args()

        self.assertEqual(error.exception.code, 0)
        self.assertIn("usage: codex-providers", output.getvalue())

    def test_claude_accepts_max_reasoning_level(self) -> None:
        with patch.object(
            sys,
            "argv",
            ["codex-providers", "--preset", "claude", "--reasoning-level", "max"],
        ):
            args = codex_manager.parse_args()

        self.assertEqual(args.reasoning_level, "max")

    def test_non_claude_rejects_max_reasoning_level(self) -> None:
        with (
            patch.object(
                sys,
                "argv",
                ["codex-providers", "--preset", "deepseek", "--reasoning-level", "max"],
            ),
            self.assertRaises(SystemExit) as error,
        ):
            codex_manager.parse_args()

        self.assertEqual(error.exception.code, 2)


class FastModelSelectionTest(unittest.TestCase):
    class FakeUi:
        def __init__(self) -> None:
            self.menu_titles: list[str] = []

        def multi_select(self, title: str, subtitle: str, items: list[str], defaults: set[int]) -> set[int]:
            return set(range(len(items)))

        def menu(self, title: str, subtitle: str, items: list[codex_manager.MenuItem], default: int = 0) -> int:
            self.menu_titles.append(title)
            return 1 if title in {"Fast Model", "Summary"} else 0

    def test_choose_draft_prompts_for_and_uses_fast_model_for_each_provider(self) -> None:
        results = []
        args = type(
            "Args",
            (),
            {
                "source_context": None,
                "display_name": None,
                "context_window": None,
                "compact_limit": None,
                "reasoning_level": None,
                "max_concurrent_threads_per_session": None,
            },
        )()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for preset, backend in codex_manager.BACKENDS.items():
                args.preset = preset
                ui = self.FakeUi()
                with patch.object(codex_manager, "fetch_models", return_value=(list(backend.fallback_models), "test models")):
                    draft, _ = codex_manager.choose_draft(
                        ui, args, root / preset, root / "config.toml", root, root / "config.yaml"
                    )
                results.append((preset, draft.fast_model, ui.menu_titles))

        self.assertEqual(
            results,
            [
                ("claude", "claude-opus-4-8", ["Default Model", "Fast Model", "Reasoning Level", "Token Budget", "Sub-agent Concurrency", "Summary"]),
                ("deepseek", "deepseek-v4-flash", ["Default Model", "Fast Model", "Reasoning Level", "Token Budget", "Sub-agent Concurrency", "Summary"]),
                ("gemini", "gemini-3.5-flash", ["Default Model", "Fast Model", "Reasoning Level", "Token Budget", "Sub-agent Concurrency", "Summary"]),
            ],
        )


if __name__ == "__main__":
    unittest.main()
