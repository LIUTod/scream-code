from __future__ import annotations

import platform
import sys
from pathlib import Path

from inline_snapshot import snapshot


def test_pyinstaller_datas():
    from scream.utils.pyinstaller import datas

    project_root = Path(__file__).parent.parent.parent
    python_version = f"{sys.version_info.major}.{sys.version_info.minor}"
    site_packages = f".venv/lib/python{python_version}/site-packages"
    rg_binary = "rg.exe" if platform.system() == "Windows" else "rg"
    has_rg_binary = (project_root / "src/scream/deps/bin" / rg_binary).exists()
    datas = [
        (
            Path(path)
            .relative_to(project_root)
            .as_posix()
            .replace(".venv/Lib/site-packages", site_packages),
            Path(dst).as_posix(),
        )
        for path, dst in datas
    ]

    datas = [(p, d) for p, d in datas if "web/static" not in d and "vis/static" not in d]

    expected_datas = [
        (
            f"{site_packages}/dateparser/data/dateparser_tz_cache.pkl",
            "dateparser/data",
        ),
        (
            f"{site_packages}/fastmcp/../fastmcp-3.2.4.dist-info/INSTALLER",
            "fastmcp/../fastmcp-3.2.4.dist-info",
        ),
        (
            f"{site_packages}/fastmcp/../fastmcp-3.2.4.dist-info/METADATA",
            "fastmcp/../fastmcp-3.2.4.dist-info",
        ),
        (
            f"{site_packages}/fastmcp/../fastmcp-3.2.4.dist-info/RECORD",
            "fastmcp/../fastmcp-3.2.4.dist-info",
        ),
        (
            f"{site_packages}/fastmcp/../fastmcp-3.2.4.dist-info/REQUESTED",
            "fastmcp/../fastmcp-3.2.4.dist-info",
        ),
        (
            f"{site_packages}/fastmcp/../fastmcp-3.2.4.dist-info/WHEEL",
            "fastmcp/../fastmcp-3.2.4.dist-info",
        ),
        (
            f"{site_packages}/fastmcp/../fastmcp-3.2.4.dist-info/entry_points.txt",
            "fastmcp/../fastmcp-3.2.4.dist-info",
        ),
        (
            f"{site_packages}/fastmcp/../fastmcp-3.2.4.dist-info/licenses/LICENSE",
            "fastmcp/../fastmcp-3.2.4.dist-info/licenses",
        ),
        (
            "src/scream/CHANGELOG.md",
            "scream",
        ),
        ("src/scream/agents/default/agent.yaml", "scream/agents/default"),
        ("src/scream/agents/default/coder.yaml", "scream/agents/default"),
        ("src/scream/agents/default/explore.yaml", "scream/agents/default"),
        ("src/scream/agents/default/plan.yaml", "scream/agents/default"),
        ("src/scream/agents/default/system.md", "scream/agents/default"),
        ("src/scream/agents/okabe/agent.yaml", "scream/agents/okabe"),
        ("src/scream/prompts/compact.md", "scream/prompts"),
        ("src/scream/prompts/init.md", "scream/prompts"),
        (
            "src/scream/skills/scream-cli-help/SKILL.md",
            "scream/skills/scream-cli-help",
        ),
        (
            "src/scream/skills/skill-creator/SKILL.md",
            "scream/skills/skill-creator",
        ),
        ("src/scream/tools/agent/description.md", "scream/tools/agent"),
        ("src/scream/tools/ask_user/description.md", "scream/tools/ask_user"),
        (
            "src/scream/tools/dmail/dmail.md",
            "scream/tools/dmail",
        ),
        ("src/scream/tools/background/list.md", "scream/tools/background"),
        ("src/scream/tools/background/output.md", "scream/tools/background"),
        ("src/scream/tools/background/stop.md", "scream/tools/background"),
        (
            "src/scream/tools/file/glob.md",
            "scream/tools/file",
        ),
        (
            "src/scream/tools/file/grep.md",
            "scream/tools/file",
        ),
        (
            "src/scream/tools/file/read.md",
            "scream/tools/file",
        ),
        (
            "src/scream/tools/file/read_media.md",
            "scream/tools/file",
        ),
        (
            "src/scream/tools/file/replace.md",
            "scream/tools/file",
        ),
        (
            "src/scream/tools/file/write.md",
            "scream/tools/file",
        ),
        ("src/scream/tools/plan/description.md", "scream/tools/plan"),
        ("src/scream/tools/plan/enter_description.md", "scream/tools/plan"),
        ("src/scream/tools/shell/bash.md", "scream/tools/shell"),
        (
            "src/scream/tools/think/think.md",
            "scream/tools/think",
        ),
        (
            "src/scream/tools/todo/set_todo_list.md",
            "scream/tools/todo",
        ),
        (
            "src/scream/tools/web/fetch.md",
            "scream/tools/web",
        ),
        (
            "src/scream/tools/web/search.md",
            "scream/tools/web",
        ),
    ]
    if has_rg_binary:
        expected_datas.append((f"src/scream/deps/bin/{rg_binary}", "scream/deps/bin"))

    assert sorted(datas) == sorted(expected_datas)


def test_pyinstaller_hiddenimports():
    from scream.utils.pyinstaller import hiddenimports

    assert sorted(hiddenimports) == snapshot(
        [
            "scream._build_info",
            "scream.cli.export",
            "scream.cli.info",
            "scream.cli.mcp",
            "scream.cli.plugin",
            "scream.cli.vis",
            "scream.cli.web",
            "scream.tools",
            "scream.tools.agent",
            "scream.tools.ask_user",
            "scream.tools.background",
            "scream.tools.display",
            "scream.tools.dmail",
            "scream.tools.file",
            "scream.tools.file.glob",
            "scream.tools.file.grep_local",
            "scream.tools.file.plan_mode",
            "scream.tools.file.read",
            "scream.tools.file.read_media",
            "scream.tools.file.replace",
            "scream.tools.file.utils",
            "scream.tools.file.write",
            "scream.tools.plan",
            "scream.tools.plan.enter",
            "scream.tools.plan.heroes",
            "scream.tools.shell",
            "scream.tools.test",
            "scream.tools.think",
            "scream.tools.todo",
            "scream.tools.utils",
            "scream.tools.web",
            "scream.tools.web.fetch",
            "scream.tools.web.search",
            "setproctitle",
        ]
    )


def test_pyinstaller_hiddenimports_include_lazy_cli_subcommands():
    from scream.cli._lazy_group import LazySubcommandGroup
    from scream.utils.pyinstaller import hiddenimports

    expected_hiddenimports = {
        module_name
        for module_name, _attribute_name, _help_text in LazySubcommandGroup.lazy_subcommands.values()
    }

    assert expected_hiddenimports <= set(hiddenimports)
