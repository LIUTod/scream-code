from __future__ import annotations

from collections.abc import Sequence
from typing import TYPE_CHECKING

from ltod.message import Message

from scream.memory.manager import MemoryManager
from scream.soul.dynamic_injection import DynamicInjection, DynamicInjectionProvider

if TYPE_CHECKING:
    from scream.soul.screamsoul import ScreamSoul


class MemoryInjectionProvider(DynamicInjectionProvider):
    """记忆注入提供器 — 在每次 LLM 调用前注入相关记忆。"""

    def __init__(self, memory_manager: MemoryManager) -> None:
        self._memory_manager = memory_manager
        self._last_query = ""
        self._last_injected_ids: set[str] = set()

    async def get_injections(
        self,
        history: Sequence[Message],
        soul: ScreamSoul,
    ) -> list[DynamicInjection]:
        # 从最近的用户消息中提取查询
        query = self._extract_query(history)
        if not query:
            return []

        # 避免对相同查询重复注入（简短查询才比较，长查询每次都重新搜索）
        if len(query) <= 20 and query == self._last_query:
            return []
        self._last_query = query

        relevant = self._memory_manager.find_relevant(query, limit=3)
        if not relevant:
            return []

        injections: list[DynamicInjection] = []
        for entry in relevant:
            if entry.id in self._last_injected_ids:
                continue
            self._last_injected_ids.add(entry.id)
            injections.append(
                DynamicInjection(
                    type="memory",
                    content=f"[记忆] {entry.content}",
                )
            )

        return injections

    async def on_context_compacted(self) -> None:
        """上下文压缩后重置注入状态，允许记忆重新注入。"""
        self._last_injected_ids.clear()
        self._last_query = ""

    @staticmethod
    def _extract_query(history: Sequence[Message]) -> str:
        """从最近的用户消息中提取查询文本。"""
        for msg in reversed(history):
            if msg.role == "user":
                text_parts = []
                for part in msg.content:
                    if hasattr(part, "text"):
                        text_parts.append(part.text)
                    elif isinstance(part, str):
                        text_parts.append(part)
                return " ".join(text_parts)
        return ""
