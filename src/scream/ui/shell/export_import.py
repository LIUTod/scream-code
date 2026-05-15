from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from kaos.path import KaosPath

from scream.ui.shell.console import console
from scream.ui.shell.slash import ensure_scream_soul, registry, shell_mode_registry
from scream.utils.export import is_sensitive_file
from scream.utils.path import sanitize_cli_path, shorten_home
from scream.wire.types import TurnBegin, TurnEnd

if TYPE_CHECKING:
    from scream.ui.shell import Shell


# ---------------------------------------------------------------------------
# /export command
# ---------------------------------------------------------------------------


@registry.command
@shell_mode_registry.command
async def export(app: Shell, args: str):
    """导出当前会话上下文到 markdown 文件"""
    from scream.utils.export import perform_export

    soul = ensure_scream_soul(app)
    if soul is None:
        return

    session = soul.runtime.session
    result = await perform_export(
        history=list(soul.context.history),
        session_id=session.id,
        work_dir=str(session.work_dir),
        token_count=soul.context.token_count,
        args=args,
        default_dir=Path(str(session.work_dir)),
    )
    if isinstance(result, str):
        console.print(f"[yellow]{result}[/yellow]")
        return

    output, count = result
    from scream.telemetry import track

    track("export")
    display = shorten_home(KaosPath(str(output)))
    console.print(f"[green]Exported {count} messages to {display}[/green]")
    console.print(
        "[yellow]Note: The exported file may contain sensitive information. "
        "Please be cautious when sharing it externally.[/yellow]"
    )


# ---------------------------------------------------------------------------
# /import command
# ---------------------------------------------------------------------------


@registry.command(name="import")
@shell_mode_registry.command(name="import")
async def import_context(app: Shell, args: str):
    """从文件或会话 ID 导入上下文"""
    from scream.utils.export import perform_import

    soul = ensure_scream_soul(app)
    if soul is None:
        return

    target = sanitize_cli_path(args)
    if not target:
        console.print("[yellow]Usage: /import <file_path or session_id>[/yellow]")
        return

    session = soul.runtime.session
    raw_max_context_size = (
        soul.runtime.llm.max_context_size if soul.runtime.llm is not None else None
    )
    max_context_size = (
        raw_max_context_size
        if isinstance(raw_max_context_size, int) and raw_max_context_size > 0
        else None
    )
    result = await perform_import(
        target=target,
        current_session_id=session.id,
        work_dir=session.work_dir,
        context=soul.context,
        max_context_size=max_context_size,
    )
    if isinstance(result, str):
        console.print(f"[red]{result}[/red]")
        return

    source_desc, content_len = result
    from scream.telemetry import track

    track("import")

    # Write to wire file so the import appears in session replay
    await soul.wire_file.append_message(
        TurnBegin(user_input=f"[Imported context from {source_desc}]")
    )
    await soul.wire_file.append_message(TurnEnd())

    console.print(
        f"[green]Imported context from {source_desc} "
        f"({content_len} chars) into current session.[/green]"
    )
    if source_desc.startswith("file") and is_sensitive_file(Path(target).name):
        console.print(
            "[yellow]Warning: This file may contain secrets (API keys, tokens, credentials). "
            "The content is now part of your session context.[/yellow]"
        )
