from __future__ import annotations

import asyncio
import contextlib
import re
import shlex
import subprocess
from enum import Enum, auto

import aiohttp

from scream.share import get_share_dir
from scream.ui.shell.console import console
from scream.utils.aiohttp import new_client_session
from scream.utils.logging import logger

GITHUB_OWNER = "LIUTod"
GITHUB_REPO = "scream-code"
LATEST_RELEASE_API_URL = (
    f"https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}/releases/latest"
)
GITHUB_RELEASES_DOWNLOAD_URL = (
    f"https://github.com/{GITHUB_OWNER}/{GITHUB_REPO}/releases/download"
)

# Upgrade command shown in toast notifications. Can be overridden by wrappers
UPGRADE_COMMAND = "uv tool upgrade scream-code"


class UpdateResult(Enum):
    UPDATE_AVAILABLE = auto()
    UPDATED = auto()
    UP_TO_DATE = auto()
    FAILED = auto()


_UPDATE_LOCK = asyncio.Lock()


def semver_tuple(version: str) -> tuple[int, int, int]:
    v = version.strip()
    if v.startswith("v"):
        v = v[1:]
    match = re.match(r"^(\d+)\.(\d+)(?:\.(\d+))?", v)
    if not match:
        return (0, 0, 0)
    major = int(match.group(1))
    minor = int(match.group(2))
    patch = int(match.group(3) or 0)
    return (major, minor, patch)


async def _get_latest_version(session: aiohttp.ClientSession) -> str | None:
    try:
        headers = {"Accept": "application/vnd.github+json"}
        async with session.get(LATEST_RELEASE_API_URL, headers=headers) as resp:
            resp.raise_for_status()
            data = await resp.json()
            tag_name = data.get("tag_name", "").strip()
            return tag_name.lstrip("v").strip()
    except (TimeoutError, aiohttp.ClientError):
        logger.exception("Failed to get latest version from GitHub:")
        return None


async def do_update(*, print: bool = True, check_only: bool = False) -> UpdateResult:
    async with _UPDATE_LOCK:
        return await _do_update(print=print, check_only=check_only)


LATEST_VERSION_FILE = get_share_dir() / "latest_version.txt"
SKIPPED_VERSION_FILE = get_share_dir() / "skipped_version.txt"
CHANGELOG_URL = "https://github.com/LIUTod/scream-code/releases"


def _read_key() -> str:
    """Read a single character from stdin in raw terminal mode."""
    import sys

    if sys.platform == "win32":
        import msvcrt

        return msvcrt.getwch()
    else:
        import termios
        import tty

        fd = sys.stdin.fileno()
        old = termios.tcgetattr(fd)
        try:
            tty.setraw(fd)
            return sys.stdin.read(1)
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, old)


def check_update_gate() -> None:
    """Block interactive shell startup if a newer version is cached locally."""
    import sys

    from scream.constant import VERSION as current_version
    from scream.utils.envvar import get_env_bool

    if get_env_bool("SCREAM_CLI_NO_AUTO_UPDATE"):
        return
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        return
    if not LATEST_VERSION_FILE.exists():
        return

    try:
        latest_version = LATEST_VERSION_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        return
    if semver_tuple(latest_version) <= semver_tuple(current_version):
        return

    if SKIPPED_VERSION_FILE.exists():
        try:
            skipped = SKIPPED_VERSION_FILE.read_text(encoding="utf-8").strip()
        except OSError:
            skipped = ""
        if skipped == latest_version:
            return

    _run_update_gate(current_version, latest_version)


def _run_update_gate(current_version: str, latest_version: str) -> None:
    """Display the blocking update UI and handle user key input."""
    import sys

    from rich.panel import Panel
    from rich.rule import Rule
    from rich.text import Text

    body = Text.assemble(
        ("  当前版本   ", ""),
        (current_version + "\n", ""),
        ("  最新版本    ", ""),
        (latest_version + "\n\n", "bold green"),
        ("  更新内容:\n", ""),
        ("    · ", ""),
        (CHANGELOG_URL + "\n", "medium_turquoise"),
    )
    console.print()
    console.print(
        Panel(
            body,
            title="[bold]scream-cli 更新可用[/bold]",
            border_style="yellow",
            expand=False,
            padding=(1, 2),
        )
    )
    console.print(Rule(style="grey50"))
    console.print(
        Text.assemble(
            "  ",
            ("[Enter]", "bold"),
            "  立即升级  ",
            (f"({UPGRADE_COMMAND})", "grey50"),
        )
    )
    console.print(Text.assemble("  ", ("[q]", "bold"), "      暂不升级，下次提醒"))
    console.print(
        Text.assemble("  ", ("[s]", "bold"), "      跳过此版本提醒")
    )
    console.print(Rule(style="grey50"))
    console.print()

    key = _read_key()
    console.print()

    if key in ("\r", "\n"):
        console.print(f"[grey50]正在运行: {UPGRADE_COMMAND}[/grey50]\n")
        try:
            result = subprocess.run(shlex.split(UPGRADE_COMMAND))
        except OSError:
            console.print()
            console.print("[red]升级失败，请手动运行:[/red]")
            console.print(f"  {UPGRADE_COMMAND}")
            sys.exit(1)
        console.print()
        if result.returncode == 0:
            console.print("[green]升级完成！请运行 scream-cli 启动新版本。[/green]")
        else:
            console.print("[red]升级失败，请手动运行:[/red]")
            console.print(f"  {UPGRADE_COMMAND}")
        sys.exit(result.returncode)
    elif key in ("s", "S"):
        with contextlib.suppress(OSError):
            SKIPPED_VERSION_FILE.write_text(latest_version, encoding="utf-8")
        console.print(f"[grey50]已跳过版本 {latest_version} 的提醒。[/grey50]\n")
    elif key in ("\x03", "\x1b"):
        sys.exit(0)
    # q/Q/other: fall through, continue startup


async def _do_update(*, print: bool, check_only: bool) -> UpdateResult:
    from scream.constant import VERSION as current_version

    def _print(message: str) -> None:
        if print:
            console.print(message)

    async with new_client_session() as session:
        logger.info("Checking for updates...")
        _print("检查更新中...")
        latest_version = await _get_latest_version(session)
        if not latest_version:
            _print("[red]检查更新失败。[/red]")
            return UpdateResult.FAILED

        logger.debug("Latest version: {latest_version}", latest_version=latest_version)
        LATEST_VERSION_FILE.write_text(latest_version, encoding="utf-8")

        cur_t = semver_tuple(current_version)
        lat_t = semver_tuple(latest_version)

        if cur_t >= lat_t:
            logger.debug("Already up to date: {current_version}", current_version=current_version)
            _print("[green]已是最新版本。[/green]")
            return UpdateResult.UP_TO_DATE

        if check_only:
            logger.info(
                "Update available: current={current_version}, latest={latest_version}",
                current_version=current_version,
                latest_version=latest_version,
            )
            _print(f"[yellow]发现新版本: {latest_version}[/yellow]")
            return UpdateResult.UPDATE_AVAILABLE

        logger.info(
            "Update available: current={current_version}, latest={latest_version}",
            current_version=current_version,
            latest_version=latest_version,
        )
        _print(f"[yellow]发现新版本: {latest_version}[/yellow]")
        _print(f"[grey50]当前版本: {current_version}[/grey50]")
        _print("[grey50]请运行以下命令升级:[/grey50]")
        _print(f"  {UPGRADE_COMMAND}")
        return UpdateResult.UPDATE_AVAILABLE


# @meta_command
# async def update(app: "Shell", args: list[str]):
#     """Check for updates"""
#     await do_update(print=True)


# @meta_command(name="check-update")
# async def check_update(app: "Shell", args: list[str]):
#     """Check for updates"""
#     await do_update(print=True, check_only=True)
