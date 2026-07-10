from __future__ import annotations

import importlib.machinery
import importlib.util
import subprocess
import sys
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


if __name__ == "__main__":
    unittest.main()
