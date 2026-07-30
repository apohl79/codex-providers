from __future__ import annotations

import importlib.machinery
import importlib.util
import sys
import json
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "codex-manager"
LOADER = importlib.machinery.SourceFileLoader("codex_manager_missing_key", str(MODULE_PATH))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
if SPEC is None:
    raise RuntimeError(f"Could not load {MODULE_PATH}")
codex_manager = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = codex_manager
LOADER.exec_module(codex_manager)


class GeminiCredentialPromptTest(unittest.TestCase):
    def test_saved_gemini_credential_is_detected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            credential = Path(directory) / "gemini-gemini-api-key@gemini_api_key.json"
            credential.write_text(json.dumps({"provider": "gemini", "access_token": "value"}))

            detected = codex_manager.has_gemini_login(Path(directory), "GEMINI_API_KEY")

        self.assertTrue(detected)


if __name__ == "__main__":
    unittest.main()
