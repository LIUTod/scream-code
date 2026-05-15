from __future__ import annotations

import os
import shlex
from pathlib import Path

from harbor.agents.installed.scream import ScreamCli
from harbor.environments.base import BaseEnvironment


class LocalScreamCli(ScreamCli):
    """Harbor Scream agent that installs scream-cli from a local wheel."""

    @staticmethod
    def name() -> str:
        return "scream-cli-local"

    async def install(self, environment: BaseEnvironment) -> None:
        wheel_path = os.environ.get("SCREAM_CLI_WHEEL_PATH")
        if wheel_path:
            wheel_file = Path(wheel_path)
            if not wheel_file.is_file():
                raise ValueError(f"SCREAM_CLI_WHEEL_PATH does not exist: {wheel_path}")
            await self.exec_as_root(
                environment,
                command="apt-get update && apt-get install -y curl",
                env={"DEBIAN_FRONTEND": "noninteractive"},
            )
            wheel_target = f"/tmp/{wheel_file.name}"
            await environment.upload_file(wheel_file, wheel_target)
            install_cmd = (
                "set -euo pipefail; "
                "curl -LsSf https://astral.sh/uv/install.sh | bash && "
                'export PATH="$HOME/.local/bin:$PATH" && '
                f"uv tool install --python 3.13 {shlex.quote(wheel_target)} && "
                "scream --version"
            )
            await self.exec_as_agent(environment, command=install_cmd)
            return

        raise ValueError("SCREAM_CLI_WHEEL_PATH is required.")
