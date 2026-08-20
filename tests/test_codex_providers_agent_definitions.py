from __future__ import annotations

import importlib.machinery
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "codex-providers"
LOADER = importlib.machinery.SourceFileLoader(
    "codex_manager_generated_files",
    str(MODULE_PATH),
)
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
if SPEC is None:
    raise RuntimeError(f"Could not load {MODULE_PATH}")
codex_manager = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = codex_manager
LOADER.exec_module(codex_manager)


class GeneratedFilesTest(unittest.TestCase):
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
            360000,
            8,
            codex_home / "claude-models.json",
            False,
        )

    def test_write_files_does_not_generate_general_purpose_agents(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            codex_home = root / "codex"

            codex_manager.write_files(
                self._draft(root),
                codex_home / "config.toml",
                MODULE_PATH.parent,
                root / "auth2api.yaml",
                {"models": []},
            )
            generated_files = sorted(
                path.relative_to(root).as_posix()
                for path in root.rglob("*")
                if path.is_file()
            )

        self.assertEqual(
            generated_files,
            [
                "auth2api.yaml",
                "codex/claude-models.json",
                "codex/claude.config.toml",
                "codex/config.toml",
            ],
        )

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
