"""Tests for the `skip_afk_prompt_injection` config gate.

Yolo no longer has a dynamic prompt. This field gates only the afk prompt
provider. Plan mode injection is unaffected.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from ltod.tooling.empty import EmptyToolset

from scream.soul.agent import Agent, Runtime
from scream.soul.context import Context
from scream.soul.dynamic_injections.afk_mode import AfkModeInjectionProvider
from scream.soul.dynamic_injections.plan_mode import PlanModeInjectionProvider
from scream.soul.screamsoul import ScreamSoul


def _make_soul(runtime: Runtime, tmp_path: Path) -> ScreamSoul:
    agent = Agent(
        name="Test Agent",
        system_prompt="Test system prompt.",
        toolset=EmptyToolset(),
        runtime=runtime,
    )
    return ScreamSoul(agent, context=Context(file_backend=tmp_path / "history.jsonl"))


def _provider_types(soul: ScreamSoul) -> set[type]:
    # Access the private list to introspect provider composition.
    return {type(p) for p in soul._injection_providers}  # pyright: ignore[reportPrivateUsage]


@pytest.mark.parametrize("skip", [False, True])
def test_skip_afk_prompt_injection_gates_afk_provider(
    runtime: Runtime, tmp_path: Path, skip: bool
) -> None:
    runtime.config.skip_afk_prompt_injection = skip
    soul = _make_soul(runtime, tmp_path)
    types_ = _provider_types(soul)

    # Plan is always present and never gated by this flag.
    assert PlanModeInjectionProvider in types_
    assert not any(provider.__name__.lower().startswith("yolo") for provider in types_)

    if skip:
        assert AfkModeInjectionProvider not in types_
    else:
        assert AfkModeInjectionProvider in types_
