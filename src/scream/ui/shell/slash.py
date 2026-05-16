from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Iterable
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

from prompt_toolkit.shortcuts import PromptSession
from prompt_toolkit.shortcuts.choice_input import ChoiceInput

from scream import logger
from scream.cli import Reload
from scream.config import LLMModel, LLMProvider, get_config_file, load_config, save_config
from scream.exception import ConfigError
from scream.session import Session
from scream.soul.screamsoul import ScreamSoul
from scream.ui.shell.console import console
from scream.ui.shell.mcp_status import render_mcp_console
from scream.ui.shell.task_browser import TaskBrowserApp
from scream.utils.changelog import CHANGELOG
from scream.utils.slashcmd import SlashCommand, SlashCommandRegistry

if TYPE_CHECKING:
    from scream.ui.shell import Shell

type ShellSlashCmdFunc = Callable[[Shell, str], None | Awaitable[None]]
"""
A function that runs as a Shell-level slash command.

Raises:
    Reload: When the configuration should be reloaded.
"""


registry = SlashCommandRegistry[ShellSlashCmdFunc]()
shell_mode_registry = SlashCommandRegistry[ShellSlashCmdFunc]()


def ensure_scream_soul(app: Shell) -> ScreamSoul | None:
    if not isinstance(app.soul, ScreamSoul):
        console.print("[red]ScreamSoul required[/red]")
        return None
    return app.soul


@registry.command(aliases=["quit"])
@shell_mode_registry.command(aliases=["quit"])
def exit(app: Shell, args: str):
    """退出应用"""
    # should be handled by `Shell`
    raise NotImplementedError


SKILL_COMMAND_PREFIX = "skill:"

_KEYBOARD_SHORTCUTS = [
    ("Ctrl-X", "Toggle agent/shell mode"),
    ("Shift-Tab", "Toggle plan mode (read-only research)"),
    ("Ctrl-O", "Edit in external editor ($VISUAL/$EDITOR)"),
    ("Ctrl-J / Alt-Enter", "Insert newline"),
    ("Ctrl-V", "Paste (supports images)"),
    ("Ctrl-D", "Exit"),
    ("Ctrl-C", "Interrupt"),
]


def _unique_commands(commands: Iterable[SlashCommand[Any]]) -> list[SlashCommand[Any]]:
    unique: list[SlashCommand[Any]] = []
    seen: set[str] = set()
    for cmd in commands:
        if cmd.name in seen:
            continue
        unique.append(cmd)
        seen.add(cmd.name)
    return unique


def _expanded_command_items(commands: Iterable[SlashCommand[Any]]) -> list[tuple[str, str]]:
    items: list[tuple[str, str]] = []
    for cmd in sorted(_unique_commands(commands), key=lambda c: c.name):
        seen = {cmd.name}
        items.append((cmd.display_name(cmd.name), cmd.description))
        for alias in cmd.aliases:
            if alias in seen:
                continue
            items.append((cmd.display_name(alias), cmd.description))
            seen.add(alias)
    return items


@registry.command(aliases=["h", "?"])
@shell_mode_registry.command(aliases=["h", "?"])
def help(app: Shell, args: str):
    """显示帮助信息"""
    from rich.console import Group, RenderableType
    from rich.text import Text

    from scream.utils.rich.columns import BulletColumns

    def section(title: str, items: list[tuple[str, str]], color: str) -> BulletColumns:
        lines: list[RenderableType] = [Text.from_markup(f"[bold]{title}:[/bold]")]
        for name, desc in items:
            lines.append(
                BulletColumns(
                    Text.from_markup(f"[{color}]{name}[/{color}]: [grey50]{desc}[/grey50]"),
                    bullet_style=color,
                )
            )
        return BulletColumns(Group(*lines))

    renderables: list[RenderableType] = []
    renderables.append(
        BulletColumns(
            Group(
                Text.from_markup("[grey50]Help! I need somebody. Help! Not just anybody.[/grey50]"),
                Text.from_markup("[grey50]Help! You know I need someone. Help![/grey50]"),
                Text.from_markup("[grey50]\u2015 The Beatles, [italic]Help![/italic][/grey50]"),
            ),
            bullet_style="grey50",
        )
    )
    renderables.append(
        BulletColumns(
            Text(
                "Scream \u5df2\u5c31\u7eea\uff01"
                "\u53d1\u9001\u6d88\u606f\u5373\u53ef\u5f00\u59cb\uff0c\u6211\u4f1a\u5e2e\u4f60\u5b8c\u6210\u5404\u79cd\u4efb\u52a1\uff01"
            ),
        )
    )

    commands: list[SlashCommand[Any]] = []
    skills: list[SlashCommand[Any]] = []
    for cmd in app.available_slash_commands.values():
        if cmd.name.startswith(SKILL_COMMAND_PREFIX):
            skills.append(cmd)
        else:
            commands.append(cmd)

    renderables.append(section("\u5feb\u6377\u952e", _KEYBOARD_SHORTCUTS, "yellow"))
    renderables.append(
        section(
            "\u659c\u6760\u547d\u4ee4",
            _expanded_command_items(commands),
            "blue",
        )
    )
    if skills:
        renderables.append(
            section(
                "\u6280\u80fd",
                _expanded_command_items(skills),
                "cyan",
            )
        )

    with console.pager(styles=True):
        console.print(Group(*renderables))


@registry.command
async def btw(app: Shell, args: str):
    """旁路提问，不中断主对话"""
    question = args.strip()
    if not question:
        console.print('[yellow]Usage: "/btw <question>"[/yellow]')
        return
    if ensure_scream_soul(app) is None:
        return
    if app._prompt_session is None:  # pyright: ignore[reportPrivateUsage]
        console.print("[yellow]/btw is only available in interactive shell mode.[/yellow]")
        return
    await app._run_btw_modal(question, app._prompt_session)  # pyright: ignore[reportPrivateUsage]


@registry.command
@shell_mode_registry.command
def version(app: Shell, args: str):
    """显示版本信息"""
    from scream.constant import VERSION

    console.print(f"scream, 版本 {VERSION}")


@registry.command
async def model(app: Shell, args: str):
    """切换 LLM 模型或思考模式"""
    from scream.llm import derive_model_capabilities

    soul = ensure_scream_soul(app)
    if soul is None:
        return
    config = soul.runtime.config

    if not config.models:
        console.print('[yellow]未配置模型。请通过配置文件添加。[/yellow]')
        return

    if not config.is_from_default_location:
        console.print(
            "[yellow]切换模型需要使用默认配置文件；"
            "请不使用 --config/--config-file 参数重启。[/yellow]"
        )
        return

    # Find current model/thinking from runtime (may be overridden by --model/--thinking)
    curr_model_cfg = soul.runtime.llm.model_config if soul.runtime.llm else None
    curr_model_name: str | None = None
    if curr_model_cfg is not None:
        for name, model_cfg in config.models.items():
            if model_cfg == curr_model_cfg:
                curr_model_name = name
                break
    curr_thinking = soul.thinking

    # Step 1: Select model (or delete)
    model_choices: list[tuple[str, str]] = []
    for name in sorted(config.models):
        model_cfg = config.models[name]
        provider_label = model_cfg.provider
        marker = " (current)" if name == curr_model_name else ""
        display = model_cfg.display_name or model_cfg.model
        label = f"{display} ({provider_label}){marker}"
        model_choices.append((name, label))

    # Add delete option when there are multiple models
    can_delete = len(config.models) > 1
    if can_delete:
        model_choices.append(("__delete__", "删除模型..."))

    try:
        selected_model_name = await ChoiceInput(
            message="Select a model (↑↓ navigate, Enter select, Ctrl+C cancel):",
            options=model_choices,
            default=curr_model_name or model_choices[0][0],
        ).prompt_async()
    except (EOFError, KeyboardInterrupt):
        return

    if not selected_model_name:
        return

    # Handle delete
    if selected_model_name == "__delete__":
        config_file = config.source_file or get_config_file()
        await _delete_model_flow(config, curr_model_name, config_file)
        return

    selected_model_cfg = config.models[selected_model_name]
    selected_provider = config.providers.get(selected_model_cfg.provider)
    if selected_provider is None:
        console.print(f"[red]Provider not found: {selected_model_cfg.provider}[/red]")
        return

    # Step 2: Determine thinking mode
    capabilities = derive_model_capabilities(selected_model_cfg)
    new_thinking: bool

    if "always_thinking" in capabilities:
        new_thinking = True
    elif "thinking" in capabilities:
        thinking_choices: list[tuple[str, str]] = [
            ("off", "off" + (" (current)" if not curr_thinking else "")),
            ("on", "on" + (" (current)" if curr_thinking else "")),
        ]
        try:
            thinking_selection = await ChoiceInput(
                message="Enable thinking mode? (↑↓ navigate, Enter select, Ctrl+C cancel):",
                options=thinking_choices,
                default="on" if curr_thinking else "off",
            ).prompt_async()
        except (EOFError, KeyboardInterrupt):
            return

        if not thinking_selection:
            return

        new_thinking = thinking_selection == "on"
    else:
        new_thinking = False

    # Check if anything changed
    model_changed = curr_model_name != selected_model_name
    thinking_changed = curr_thinking != new_thinking
    selected_display = selected_model_cfg.display_name or selected_model_cfg.model

    if not model_changed and not thinking_changed:
        console.print(
            f"[yellow]已经在使用 {selected_display} "
            f"思考模式 {'开启' if new_thinking else '关闭'}。[/yellow]"
        )
        return

    # Save and reload
    prev_model = config.default_model
    prev_thinking = config.default_thinking
    config.default_model = selected_model_name
    config.default_thinking = new_thinking
    try:
        config_for_save = load_config()
        config_for_save.default_model = selected_model_name
        config_for_save.default_thinking = new_thinking
        save_config(config_for_save)
    except (ConfigError, OSError) as exc:
        config.default_model = prev_model
        config.default_thinking = prev_thinking
        console.print(f"[red]保存配置失败: {exc}[/red]")
        return

    from scream.telemetry import track

    if model_changed:
        track("model_switch", model=selected_model_name)
    if thinking_changed:
        track("thinking_toggle", enabled=new_thinking)
    console.print(
        f"[green]已切换到 {selected_display} "
        f"思考模式 {'开启' if new_thinking else '关闭'}。"
        "正在重载...[/green]"
    )
    raise Reload(session_id=soul.runtime.session.id)


async def _delete_model_flow(
    config: Any, curr_model_name: str | None, config_file: Path
) -> None:
    """删除模型子流程。"""
    # Build deletable choices (exclude current model)
    deletable: list[tuple[str, str]] = []
    for name in sorted(config.models):
        if name == curr_model_name:
            continue
        model_cfg = config.models[name]
        provider_label = model_cfg.provider
        display = model_cfg.display_name or model_cfg.model
        label = f"{display} ({provider_label})"
        deletable.append((name, label))

    if not deletable:
        console.print("[yellow]没有可删除的模型（不能删除当前正在使用的模型）。[/yellow]")
        return

    try:
        del_name = await ChoiceInput(
            message="选择要删除的模型 (↑↓ navigate, Enter select, Ctrl+C cancel):",
            options=deletable,
            default=deletable[0][0],
        ).prompt_async()
    except (EOFError, KeyboardInterrupt):
        return

    if not del_name:
        return

    del_cfg = config.models[del_name]
    del_provider = del_cfg.provider
    del_display = del_cfg.display_name or del_cfg.model

    # Confirm deletion
    try:
        confirm = await ChoiceInput(
            message=f"确认删除模型 '{del_display}'？",
            options=[("yes", "确认删除"), ("no", "取消")],
            default="no",
        ).prompt_async()
    except (EOFError, KeyboardInterrupt):
        return

    if confirm != "yes":
        console.print("[yellow]已取消删除。[/yellow]")
        return

    # Remove model
    try:
        config_for_save = load_config(config_file)
        if del_name in config_for_save.models:
            del config_for_save.models[del_name]

        # Check if provider is still referenced by any other model
        provider_still_used = any(
            m.provider == del_provider for m in config_for_save.models.values()
        )
        if not provider_still_used and del_provider in config_for_save.providers:
            del config_for_save.providers[del_provider]

        save_config(config_for_save, config_file)
    except (ConfigError, OSError) as exc:
        console.print(f"[red]删除失败: {exc}[/red]")
        return

    from scream.telemetry import track

    track("model_delete", model=del_name)
    console.print(f"[green]已删除模型 '{del_display}'。[/green]")


@registry.command
@shell_mode_registry.command
async def config(app: Shell, args: str) -> None:
    """交互式配置模型（默认 anthropic 协议）"""
    from pydantic import SecretStr

    soul = ensure_scream_soul(app)
    if soul is None:
        return
    cfg = soul.runtime.config

    if not cfg.is_from_default_location:
        console.print(
            "[yellow]配置交互式编辑需要使用默认配置文件；"
            "请不使用 --config/--config-file 参数启动。[/yellow]"
        )
        return

    config_file = cfg.source_file or get_config_file()

    # Step 1: API URL
    try:
        base_url_result = await PromptSession("API 地址 > ").prompt_async(
            default="https://api.anthropic.com/v1",
        )
    except (EOFError, KeyboardInterrupt):
        return
    if base_url_result is None:
        return
    base_url = base_url_result.strip() or "https://api.anthropic.com/v1"

    # Step 2: API Key
    try:
        api_key_result = await PromptSession("API Key > ").prompt_async()
    except (EOFError, KeyboardInterrupt):
        return
    if api_key_result is None:
        return
    api_key = api_key_result.strip()
    if not api_key:
        console.print("[yellow]API Key 不能为空，已取消。[/yellow]")
        return

    # Step 3: 模型型号
    try:
        model_name_result = await PromptSession("模型型号 > ").prompt_async(
            default="claude-sonnet-4-6",
        )
    except (EOFError, KeyboardInterrupt):
        return
    if model_name_result is None:
        return
    model_name = model_name_result.strip() or "claude-sonnet-4-6"

    # Step 4: Provider 名称
    try:
        provider_name_result = await PromptSession("Provider 名称 > ").prompt_async(
            default="anthropic",
        )
    except (EOFError, KeyboardInterrupt):
        return
    if provider_name_result is None:
        return
    provider_name = provider_name_result.strip() or "anthropic"

    # Step 5: Model 别名
    try:
        model_key_result = await PromptSession("Model 别名 > ").prompt_async(
            default="default",
        )
    except (EOFError, KeyboardInterrupt):
        return
    if model_key_result is None:
        return
    model_key = model_key_result.strip() or "default"

    # Detect provider type from URL
    provider_type = "anthropic"
    if "anthropic" in base_url.lower():
        provider_type = "anthropic"
    elif "openai" in base_url.lower() or "deepseek" in base_url.lower():
        provider_type = "openai_legacy"
    elif "gemini" in base_url.lower() or "google" in base_url.lower():
        provider_type = "gemini"

    provider_cfg = LLMProvider(
        type=provider_type,
        base_url=base_url,
        api_key=SecretStr(api_key),
    )
    model_cfg = LLMModel(
        provider=provider_name,
        model=model_name,
        max_context_size=200_000,
    )

    try:
        config_for_save = load_config(config_file)

        # Check for name conflicts
        if provider_name in config_for_save.providers:
            try:
                overwrite = await ChoiceInput(
                    message=f"Provider '{provider_name}' 已存在，是否覆盖？",
                    options=[("yes", "覆盖"), ("no", "取消")],
                    default="no",
                ).prompt_async()
            except (EOFError, KeyboardInterrupt):
                return
            if overwrite != "yes":
                console.print("[yellow]已取消。[/yellow]")
                return

        if model_key in config_for_save.models:
            try:
                overwrite = await ChoiceInput(
                    message=f"Model '{model_key}' 已存在，是否覆盖？",
                    options=[("yes", "覆盖"), ("no", "取消")],
                    default="no",
                ).prompt_async()
            except (EOFError, KeyboardInterrupt):
                return
            if overwrite != "yes":
                console.print("[yellow]已取消。[/yellow]")
                return

        # Append/update instead of overwrite
        config_for_save.providers[provider_name] = provider_cfg
        config_for_save.models[model_key] = model_cfg
        if not config_for_save.default_model:
            config_for_save.default_model = model_key
        save_config(config_for_save, config_file)
    except (ConfigError, OSError) as exc:
        console.print(f"[red]保存配置失败: {exc}[/red]")
        return

    from scream.telemetry import track

    track("config_interactive", provider=provider_name, model=model_name)
    cfg_msg = f"provider={provider_name}, model={model_key}({model_name})"
    console.print(
        f"[green]已保存配置：{cfg_msg}, url={base_url}。"
        "正在重载...[/green]"
    )
    raise Reload(session_id=soul.runtime.session.id)


@registry.command
@shell_mode_registry.command
async def editor(app: Shell, args: str):
    """设置 Ctrl-O 默认外部编辑器"""
    from scream.utils.editor import get_editor_command

    soul = ensure_scream_soul(app)
    if soul is None:
        return
    config = soul.runtime.config
    config_file = config.source_file
    if config_file is None:
        console.print(
            "[yellow]内联 --config 模式下无法切换编辑器；"
            "请使用 --config-file 以持久化此设置。[/yellow]"
        )
        return

    current_editor = config.default_editor

    # If args provided directly, use as editor command
    if args.strip():
        new_editor = args.strip()
    else:
        options: list[tuple[str, str]] = [
            ("code --wait", "VS Code (code --wait)"),
            ("vim", "Vim"),
            ("nano", "Nano"),
            ("", "Auto-detect (use $VISUAL/$EDITOR)"),
        ]
        # Mark current selection
        options = [
            (val, label + (" ← current" if val == current_editor else "")) for val, label in options
        ]

        try:
            choice = cast(
                str | None,
                await ChoiceInput(
                    message="Select an editor (↑↓ navigate, Enter select, Ctrl+C cancel):",
                    options=options,
                    default=(
                        current_editor
                        if current_editor in {v for v, _ in options}
                        else "code --wait"
                    ),
                ).prompt_async(),
            )
        except (EOFError, KeyboardInterrupt):
            return

        if choice is None:
            return
        new_editor = choice

    # Validate the editor binary is available
    if new_editor:
        import shlex
        import shutil

        try:
            parts = shlex.split(new_editor)
        except ValueError:
            console.print(f"[red]Invalid editor command: {new_editor}[/red]")
            return

        binary = parts[0]
        if not shutil.which(binary):
            console.print(
                f"[yellow]警告: '{binary}' 未在 PATH 中找到。"
                f"仍保存设置 — 使用 Ctrl-O 前请确保已安装。[/yellow]"
            )

    if new_editor == current_editor:
        console.print(f"[yellow]编辑器已设置为: {new_editor or 'auto-detect'}[/yellow]")
        return

    # Save to disk
    try:
        config_for_save = load_config(config_file)
        config_for_save.default_editor = new_editor
        save_config(config_for_save, config_file)
    except (ConfigError, OSError) as exc:
        console.print(f"[red]Failed to save config: {exc}[/red]")
        return

    # Sync in-memory config so Ctrl-O picks it up immediately
    config.default_editor = new_editor

    if new_editor:
        console.print(f"[green]编辑器已设置为: {new_editor}[/green]")
    else:
        resolved = get_editor_command()
        label = " ".join(resolved) if resolved else "无"
        console.print(f"[green]编辑器已设置为自动检测（解析为: {label}）[/green]")


@registry.command(aliases=["release-notes"])
@shell_mode_registry.command(aliases=["release-notes"])
def changelog(app: Shell, args: str):
    """显示发布说明"""
    from rich.console import Group, RenderableType
    from rich.text import Text

    from scream.utils.rich.columns import BulletColumns

    renderables: list[RenderableType] = []
    for ver, entry in CHANGELOG.items():
        title = f"[bold]{ver}[/bold]"
        if entry.description:
            title += f": {entry.description}"

        lines: list[RenderableType] = [Text.from_markup(title)]
        for item in entry.entries:
            if item.lower().startswith("lib:"):
                continue
            lines.append(
                BulletColumns(
                    Text.from_markup(f"[grey50]{item}[/grey50]"),
                    bullet_style="grey50",
                ),
            )
        renderables.append(BulletColumns(Group(*lines)))

    with console.pager(styles=True):
        console.print(Group(*renderables))


@registry.command
@shell_mode_registry.command
async def feedback(app: Shell, args: str):
    """提交反馈"""
    import webbrowser

    ISSUE_URL = "https://github.com/LIUTod/scream-code/issues"
    if not webbrowser.open(ISSUE_URL):
        console.print(f"请前往 [underline]{ISSUE_URL}[/underline] 提交反馈。")


@registry.command(aliases=["reset"])
async def clear(app: Shell, args: str):
    """清空上下文"""
    if ensure_scream_soul(app) is None:
        return
    from scream.telemetry import track

    track("clear")
    await app.run_soul_command("/clear")
    raise Reload()


@registry.command
async def new(app: Shell, args: str):
    """开始新会话"""
    soul = ensure_scream_soul(app)
    if soul is None:
        return
    current_session = soul.runtime.session
    work_dir = current_session.work_dir
    # Clean up the current session if it has no content, so that chaining
    # /new commands (or switching away before the first message) does not
    # leave orphan empty session directories on disk.
    if current_session.is_empty():
        await current_session.delete()
    session = await Session.create(work_dir)
    from scream.telemetry import track

    track("session_new")
    console.print("[green]新会话已创建，正在切换...[/green]")
    raise Reload(session_id=session.id)


@registry.command(name="title", aliases=["rename"])
async def title(app: Shell, args: str):
    """设置或查看会话标题"""
    soul = ensure_scream_soul(app)
    if soul is None:
        return
    session = soul.runtime.session
    if not args.strip():
        console.print(f"会话标题: [bold]{session.title}[/bold]")
        return

    from scream.session_state import load_session_state, save_session_state

    new_title = args.strip()[:200]
    # Read-modify-write: load fresh state to avoid overwriting concurrent web changes
    fresh = load_session_state(session.dir)
    fresh.custom_title = new_title
    fresh.title_generated = True
    save_session_state(fresh, session.dir)
    session.state.custom_title = new_title
    session.state.title_generated = True
    session.title = new_title
    console.print(f"[green]会话标题已设置为: {new_title}[/green]")


@registry.command(name="sessions", aliases=["resume"])
async def list_sessions(app: Shell, args: str):
    """列出会话并可选恢复"""
    import shlex

    from scream.ui.shell.session_picker import SessionPickerApp

    soul = ensure_scream_soul(app)
    if soul is None:
        return

    current_session = soul.runtime.session
    result = await SessionPickerApp(
        work_dir=current_session.work_dir,
        current_session=current_session,
    ).run()

    if result is None:
        return

    selection, selected_work_dir = result

    if selection == current_session.id:
        console.print("[yellow]你已经在当前会话中。[/yellow]")
        return

    if selected_work_dir != current_session.work_dir:
        cmd = f"scream --work-dir {shlex.quote(str(selected_work_dir))} --session {selection}"
        console.print(f"[yellow]会话位于不同目录。请运行:[/yellow]\n  {cmd}")
        return

    from scream.telemetry import track

    track("session_resume")
    console.print(f"[green]正在切换到会话 {selection}...[/green]")
    raise Reload(session_id=selection)


@registry.command(name="task")
@shell_mode_registry.command(name="task")
async def task(app: Shell, args: str):
    """浏览和管理后台任务"""
    soul = ensure_scream_soul(app)
    if soul is None:
        return
    if args.strip():
        console.print('[yellow]用法："/task" 打开交互式任务浏览器。[/yellow]')
        return
    if soul.runtime.role != "root":
        console.print("[yellow]后台任务仅根代理可用。[/yellow]")
        return

    await TaskBrowserApp(soul).run()


@registry.command
@shell_mode_registry.command
def theme(app: Shell, args: str):
    """切换终端配色主题（dark/light）"""
    from scream.ui.theme import get_active_theme

    soul = ensure_scream_soul(app)
    if soul is None:
        return

    current = get_active_theme()
    arg = args.strip().lower()

    if not arg:
        console.print(f"当前主题: [bold]{current}[/bold]")
        console.print("[grey50]用法: /theme dark | /theme light[/grey50]")
        return

    if arg not in ("dark", "light"):
        console.print(f"[red]未知主题: {arg}。请使用 'dark' 或 'light'。[/red]")
        return

    if arg == current:
        console.print(f"[yellow]已经在使用 {arg} 主题。[/yellow]")
        return

    config_file = soul.runtime.config.source_file
    if config_file is None:
        console.print(
            "[yellow]主题切换需要配置文件；"
            "请不使用 --config 参数重启以持久化此设置。[/yellow]"
        )
        return

    # Persist to disk first — only update in-memory state after success
    try:
        config_for_save = load_config(config_file)
        config_for_save.theme = arg  # type: ignore[assignment]
        save_config(config_for_save, config_file)
    except (ConfigError, OSError) as exc:
        console.print(f"[red]Failed to save config: {exc}[/red]")
        return

    from scream.telemetry import track

    track("theme_switch", theme=arg)
    console.print(f"[green]已切换到 {arg} 主题。正在重载...[/green]")
    raise Reload(session_id=soul.runtime.session.id)


@registry.command
async def mcp(app: Shell, args: str):
    """显示 MCP 服务器和工具"""
    from rich.live import Live

    soul = ensure_scream_soul(app)
    if soul is None:
        return
    await soul.start_background_mcp_loading()
    snapshot = soul.status.mcp_status
    if snapshot is None:
        console.print("[yellow]未配置 MCP 服务器。[/yellow]")
        return

    if not snapshot.loading:
        console.print(render_mcp_console(snapshot))
        return

    with Live(
        render_mcp_console(snapshot),
        console=console,
        refresh_per_second=8,
        transient=False,
    ) as live:
        while True:
            snapshot = soul.status.mcp_status
            if snapshot is None:
                break
            live.update(render_mcp_console(snapshot), refresh=True)
            if not snapshot.loading:
                break
            await asyncio.sleep(0.125)
        try:
            await soul.wait_for_background_mcp_loading()
        except Exception as e:
            logger.debug("MCP loading completed with error while rendering /mcp: {error}", error=e)
        snapshot = soul.status.mcp_status
        if snapshot is not None:
            live.update(render_mcp_console(snapshot), refresh=True)


@registry.command
@shell_mode_registry.command
def hooks(app: Shell, args: str):
    """列出已配置的 hooks"""
    soul = ensure_scream_soul(app)
    if soul is None:
        return

    engine = soul.hook_engine
    if not engine.summary:
        console.print(
            "[yellow]未配置 hooks。"
            "请在 config.toml 中添加 [[hooks]] 段来设置 hooks。[/yellow]"
        )
        return

    console.print()
    console.print("[bold]已配置的 Hooks:[/bold]")
    console.print()

    for event, entries in engine.details().items():
        console.print(f"  [cyan]{event}[/cyan]: {len(entries)} 个 hook")
        for entry in entries:
            source_tag = f" [dim]({entry['source']})[/dim]" if entry["source"] == "wire" else ""
            console.print(f"    [dim]{entry['matcher']}[/dim] {entry['command']}{source_tag}")

    console.print()


@registry.command
async def undo(app: Shell, args: str):
    """回退：从之前的回合分叉会话并重试"""
    from scream.session_fork import enumerate_turns, fork_session
    from scream.utils.string import shorten

    soul = ensure_scream_soul(app)
    if soul is None:
        return

    session = soul.runtime.session
    wire_path = session.dir / "wire.jsonl"
    turns = enumerate_turns(wire_path)

    if not turns:
        console.print("[yellow]No turns found in this session.[/yellow]")
        return

    # Build choices: each turn's first line, truncated
    choices: list[tuple[str, str]] = []
    for turn in turns:
        first_line = turn.user_text.split("\n", 1)[0]
        label = shorten(first_line, width=80, placeholder="...")
        choices.append((str(turn.index), f"[{turn.index}] {label}"))

    try:
        selected = await ChoiceInput(
            message="Select a turn to undo (↑↓ navigate, Enter select, Ctrl+C cancel):",
            options=choices,
            default=choices[-1][0],
        ).prompt_async()
    except (EOFError, KeyboardInterrupt):
        return

    turn_index = int(selected)

    # The selected turn is the one we want to redo — fork includes turns *before* it
    selected_turn = turns[turn_index]
    user_text = selected_turn.user_text

    if turn_index == 0:
        # Fork with no history — just the user text
        new_session = await Session.create(session.work_dir)
        new_session_id = new_session.id
        # Set title to match the convention used by fork_session
        from scream.session_state import load_session_state, save_session_state

        new_state = load_session_state(new_session.dir)
        new_state.custom_title = f"Undo: {session.title}"
        new_state.title_generated = True
        save_session_state(new_state, new_session.dir)
    else:
        # Fork includes turns 0..turn_index-1
        fork_turn_index = turn_index - 1
        new_session_id = await fork_session(
            source_session_dir=session.dir,
            work_dir=session.work_dir,
            turn_index=fork_turn_index,
            title_prefix="Undo",
            source_title=session.title,
        )

    from scream.telemetry import track

    track("undo")
    console.print(f"[green]Forked at turn {turn_index}. Switching to new session...[/green]")
    raise Reload(session_id=new_session_id, prefill_text=user_text)


@registry.command
async def fork(app: Shell, args: str):
    """分叉当前会话（将所有历史复制到新会话）"""
    from scream.session_fork import fork_session

    soul = ensure_scream_soul(app)
    if soul is None:
        return

    session = soul.runtime.session
    new_session_id = await fork_session(
        source_session_dir=session.dir,
        work_dir=session.work_dir,
        turn_index=None,
        title_prefix="Fork",
        source_title=session.title,
    )

    from scream.telemetry import track

    track("session_fork")
    console.print("[green]Session forked. Switching to new session...[/green]")
    raise Reload(session_id=new_session_id)


from . import (  # noqa: E402
    debug,  # noqa: F401 # type: ignore[reportUnusedImport]
    export_import,  # noqa: F401 # type: ignore[reportUnusedImport]
    update,  # noqa: F401 # type: ignore[reportUnusedImport]
)
