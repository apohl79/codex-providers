from __future__ import annotations

import importlib.machinery
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "codex-providers"
LOADER = importlib.machinery.SourceFileLoader(
    "codex_manager_agent_definitions",
    str(MODULE_PATH),
)
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
if SPEC is None:
    raise RuntimeError(f"Could not load {MODULE_PATH}")
codex_manager = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = codex_manager
LOADER.exec_module(codex_manager)


class AgentDefinitionsTest(unittest.TestCase):
    def _write_prompts(self, root: Path, include_subagents: bool = True) -> None:
        prompts = root / "docs" / "prompts"
        prompts.mkdir(parents=True)
        if include_subagents:
            (prompts / "subagents.md").write_text("Shared sub-agent instructions")

    def _draft(self, root: Path) -> codex_manager.Draft:
        codex_home = root / "codex"
        return codex_manager.Draft(
            "claude",
            codex_home / "claude.config.toml",
            "anthropic",
            "Claude",
            codex_manager.BACKENDS["claude"],
            "http://127.0.0.1:8317/v1",
            ("claude-opus-5",),
            "claude-opus-5",
            "claude-haiku-4-5-20251001",
            "medium",
            400000,
            380000,
            8,
            codex_home / "claude-models.json",
            False,
        )

    def test_missing_gpt_config_uses_only_shared_subagent_instructions(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._write_prompts(root)

            definitions = codex_manager.agent_definitions(self._draft(root), root)
            actual = [
                (
                    definition.path.name,
                    codex_manager.tomllib.loads(definition.content)["developer_instructions"],
                )
                for definition in definitions
            ]

        self.assertEqual(
            actual,
            [
                (
                    "general-purpose-gpt.toml",
                    "Shared sub-agent instructions",
                ),
                (
                    "general-purpose-claude.toml",
                    "Shared sub-agent instructions",
                ),
            ],
        )

    def test_existing_gpt_config_uses_only_shared_subagent_instructions(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._write_prompts(root)
            agents = root / "codex" / "agents"
            agents.mkdir(parents=True)
            (agents / "general-purpose-gpt.toml").write_text("user-managed")

            definitions = codex_manager.agent_definitions(self._draft(root), root)
            actual = [
                (
                    definition.path.name,
                    codex_manager.tomllib.loads(definition.content)["developer_instructions"],
                )
                for definition in definitions
            ]

        self.assertEqual(
            actual,
            [
                (
                    "general-purpose-claude.toml",
                    "Shared sub-agent instructions",
                ),
            ],
        )

    def test_missing_subagent_extension_fails_agent_generation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._write_prompts(root, include_subagents=False)

            with self.assertRaisesRegex(
                FileNotFoundError,
                "Subagent prompt file not found",
            ):
                codex_manager.agent_definitions(self._draft(root), root)

    def test_model_catalog_keeps_the_backend_base_prompt(self) -> None:
        catalog = codex_manager.build_catalog(
            ("claude-opus-5",),
            codex_manager.BACKENDS["claude"],
            {"models": [{"slug": "claude-opus-5"}]},
            400000,
            "medium",
        )

        self.assertEqual(
            catalog["models"][0]["base_instructions"],
            codex_manager.load_prompt(MODULE_PATH.parent, "claude"),
        )


if __name__ == "__main__":
    unittest.main()
