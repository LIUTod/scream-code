from __future__ import annotations

from scream.memory import MemoryManager
from scream.utils.logging import logger


class MemoryReviewer:
    """AI-assisted memory management interface.

    Provides conversational methods for the agent to help users
    review, search, and manage their saved memories.
    """

    def __init__(self, manager: MemoryManager) -> None:
        self._manager = manager

    def list_memories(self, scope: str | None = None) -> str:
        """Return a formatted list of memories for display."""
        entries = self._manager.list_entries(scope=scope)
        if not entries:
            return "暂无记忆条目。"

        lines: list[str] = [f"共 {len(entries)} 条记忆：", ""]
        for entry in entries:
            tag_str = f"  [标签: {', '.join(entry.tags)}]" if entry.tags else ""
            snippet = entry.content[:60]
            ellipsis = "..." if len(entry.content) > 60 else ""
            lines.append(f"- [{entry.id}] {snippet}{ellipsis}{tag_str}")
        return "\n".join(lines)

    def search_memories(self, query: str) -> str:
        """Search memories by keyword and return formatted results."""
        entries = self._manager.find_relevant(query, limit=10)
        if not entries:
            return f'未找到与 "{query}" 相关的记忆。'

        lines: list[str] = [f"找到 {len(entries)} 条相关记忆：", ""]
        for entry in entries:
            tag_str = f"  [标签: {', '.join(entry.tags)}]" if entry.tags else ""
            snippet = entry.content[:80]
            ellipsis = "..." if len(entry.content) > 80 else ""
            lines.append(f"- [{entry.id}] {snippet}{ellipsis}{tag_str}")
        return "\n".join(lines)

    def get_memory(self, entry_id: str) -> str:
        """Get full content of a single memory entry."""
        for entry in self._manager.list_entries():
            if entry.id == entry_id:
                tags = f"\n标签: {', '.join(entry.tags)}" if entry.tags else ""
                return f"[{entry.id}]{tags}\n\n{entry.content}"
        return f"未找到记忆条目: {entry_id}"

    def delete_memory(self, entry_id: str) -> str:
        """Delete a memory entry and return result message."""
        if self._manager.remove_entry(entry_id):
            logger.info("User deleted memory: {entry_id}", entry_id=entry_id)
            return f"已删除记忆: {entry_id}"
        return f"删除失败，未找到记忆: {entry_id}"

    def get_system_prompt(self) -> str:
        """Return the system prompt for the memory management assistant."""
        return """你是记忆管理助手。帮助用户查看和管理他们的自动记忆。

可用操作：
- `/memory list` — 列出所有记忆
- `/memory search <关键词>` — 搜索记忆
- `/memory get <ID>` — 查看单条记忆详情
- `/memory delete <ID>` — 删除记忆

注意事项：
- 记忆是用户与AI对话的自动总结
- 不要擅自删除记忆，必须征得用户同意
- 搜索时使用中文关键词效果最佳
- 每次回复要简洁明了"""
