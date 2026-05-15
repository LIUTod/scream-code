from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"


def _run_python(code: str) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    existing = env.get("PYTHONPATH")
    env["PYTHONPATH"] = str(SRC) if not existing else f"{SRC}{os.pathsep}{existing}"
    return subprocess.run(
        [sys.executable, "-c", code],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )


def test_import_scream_does_not_import_loguru() -> None:
    proc = _run_python(
        """
import sys
sys.modules.pop("loguru", None)
import scream
assert "loguru" not in sys.modules
print("ok")
"""
    )
    assert proc.stdout.strip() == "ok"


def test_logger_proxy_imports_loguru_on_first_use() -> None:
    proc = _run_python(
        """
import sys
sys.modules.pop("loguru", None)
from scream import logger
assert "loguru" not in sys.modules
logger.disable("unit.test")
assert "loguru" in sys.modules
print("ok")
"""
    )
    assert proc.stdout.strip() == "ok"


def test_import_scream_constant_defers_package_metadata() -> None:
    proc = _run_python(
        """
import sys
sys.modules.pop("importlib.metadata", None)
import scream.constant as constant
assert "importlib.metadata" not in sys.modules
assert constant.get_version()
assert "importlib.metadata" in sys.modules
print("ok")
"""
    )
    assert proc.stdout.strip() == "ok"


def test_root_help_lists_lazy_subcommands_without_importing_them() -> None:
    proc = _run_python(
        """
import sys
from typer.testing import CliRunner

lazy_modules = [
    "scream.cli.info",
    "scream.cli.export",
    "scream.cli.mcp",
]
for name in lazy_modules:
    sys.modules.pop(name, None)

from scream.cli import cli

assert all(name not in sys.modules for name in lazy_modules)

result = CliRunner().invoke(cli, ["--help"])
assert result.exit_code == 0, result.output
for name in ("info", "export", "mcp"):
    assert name in result.output
assert all(name not in sys.modules for name in lazy_modules)
print("ok")
"""
    )
    assert proc.stdout.strip() == "ok"


def test_info_subcommand_loads_on_demand() -> None:
    proc = _run_python(
        """
import sys
from typer.testing import CliRunner

lazy_modules = [
    "scream.cli.info",
    "scream.cli.export",
    "scream.cli.mcp",
]
for name in lazy_modules:
    sys.modules.pop(name, None)

from scream.cli import cli

result = CliRunner().invoke(cli, ["info", "--json"])
assert result.exit_code == 0, result.output
assert '"scream_version"' in result.output
assert "scream.cli.info" in sys.modules
assert "scream.cli.export" not in sys.modules
assert "scream.cli.mcp" not in sys.modules
print("ok")
"""
    )
    assert proc.stdout.strip() == "ok"


def test_package_entrypoint_fast_path_avoids_cli_import() -> None:
    proc = _run_python(
        """
import io
import sys
from contextlib import redirect_stdout

sys.modules.pop("scream.cli", None)

from scream.__main__ import main

stdout = io.StringIO()
with redirect_stdout(stdout):
    exit_code = main(["--version"])

assert exit_code == 0
assert stdout.getvalue().startswith("scream, version ")
assert "scream.cli" not in sys.modules
print("ok")
"""
    )
    assert proc.stdout.strip() == "ok"


def test_package_entrypoint_falls_back_to_cli_for_commands() -> None:
    proc = _run_python(
        """
import io
import json
import sys
from contextlib import redirect_stdout

sys.modules.pop("scream.cli", None)

from scream.__main__ import main

stdout = io.StringIO()
with redirect_stdout(stdout):
    exit_code = main(["info", "--json"])

assert exit_code in (None, 0)
assert "scream.cli" in sys.modules
payload = json.loads(stdout.getvalue())
assert payload["scream_version"]
print("ok")
"""
    )
    assert proc.stdout.strip() == "ok"


def test_cli_module_entrypoint_handles_git_bash_not_found() -> None:
    proc = _run_python(
        """
import io
import sys
from contextlib import redirect_stderr

import scream.cli.__main__ as cli_main
from scream.utils.environment import GitBashNotFoundError

def fake_cli(*_args, **_kwargs):
    raise GitBashNotFoundError("install Git for Windows")

cli_main.cli = fake_cli

stderr = io.StringIO()
with redirect_stderr(stderr):
    exit_code = cli_main.main(["--print", "hello"])

assert exit_code == 1
assert stderr.getvalue() == "Error: install Git for Windows\\n"
print("ok")
"""
    )
    assert proc.stdout.strip() == "ok"
