from __future__ import annotations

import datetime
import json
import uuid
from pathlib import Path
from typing import Any

from scream.memory.models import MemoryEntry
from scream.utils.logging import logger


class MemoryManager:
    """记忆管理器 — 项目级 + 全局级持久化记忆。"""

    def __init__(self, work_dir: Path, share_dir: Path) -> None:
        self._work_dir = work_dir
        self._share_dir = share_dir
        self._project_memory_dir = work_dir / ".scream" / "memory"
        self._global_memory_dir = share_dir / "memory"
        self._project_memory_dir.mkdir(parents=True, exist_ok=True)
        self._global_memory_dir.mkdir(parents=True, exist_ok=True)

    def add_entry(
        self, content: str, tags: list[str] | None = None, scope: str = "project"
    ) -> MemoryEntry:
        """添加记忆条目。"""
        entry_id = f"mem_{uuid.uuid4().hex[:8]}"
        now = datetime.datetime.now().isoformat()
        entry = MemoryEntry(
            id=entry_id,
            content=content,
            tags=tags or [],
            created_at=now,
            updated_at=now,
            source=scope,
        )
        memory_dir = (
            self._project_memory_dir if scope == "project" else self._global_memory_dir
        )
        file_path = memory_dir / f"{entry_id}.md"
        meta = {
            "tags": entry.tags,
            "created_at": entry.created_at,
            "updated_at": entry.updated_at,
        }
        file_body = f"---\n{json.dumps(meta, ensure_ascii=False)}\n---\n{content}"
        file_path.write_text(file_body, encoding="utf-8")
        self._update_index(scope)
        return entry

    def remove_entry(self, entry_id: str, scope: str | None = None) -> bool:
        """删除记忆条目。若未指定 scope，自动查找。"""
        if scope is None:
            for s in ["project", "global"]:
                memory_dir = (
                    self._project_memory_dir
                    if s == "project"
                    else self._global_memory_dir
                )
                file_path = memory_dir / f"{entry_id}.md"
                if file_path.exists():
                    scope = s
                    break
            else:
                return False
        memory_dir = (
            self._project_memory_dir if scope == "project" else self._global_memory_dir
        )
        file_path = memory_dir / f"{entry_id}.md"
        if file_path.exists():
            file_path.unlink()
            self._update_index(scope)
            return True
        return False

    def list_entries(self, scope: str | None = None) -> list[MemoryEntry]:
        """列出记忆条目。"""
        entries: list[MemoryEntry] = []
        scopes = [scope] if scope else ["project", "global"]
        for s in scopes:
            memory_dir = (
                self._project_memory_dir if s == "project" else self._global_memory_dir
            )
            if not memory_dir.exists():
                continue
            for file_path in sorted(memory_dir.glob("*.md")):
                if file_path.name == "MEMORY.md":
                    continue
                raw = file_path.read_text(encoding="utf-8")
                meta, content = self._parse_file(raw)
                entry = MemoryEntry(
                    id=file_path.stem,
                    content=content,
                    tags=meta.get("tags", []),
                    created_at=meta.get("created_at", ""),
                    updated_at=meta.get("updated_at", ""),
                    source=s,
                )
                entries.append(entry)
        return entries

    @staticmethod
    def _parse_file(raw: str) -> tuple[dict[str, Any], str]:
        """解析带 JSON frontmatter 的记忆文件。

        Returns:
            (metadata_dict, content)
        """
        if not raw.startswith("---\n"):
            return {}, raw
        end = raw.find("\n---", 4)
        if end == -1:
            return {}, raw
        try:
            meta = json.loads(raw[4:end])
        except json.JSONDecodeError:
            return {}, raw
        content = raw[end + 4 :].lstrip("\n")
        return meta, content

    def find_relevant(self, query: str, limit: int = 5) -> list[MemoryEntry]:
        """关键词匹配搜索相关记忆。"""
        query_tokens = self._tokenize(query)
        if not query_tokens:
            return []
        all_entries = self.list_entries()
        scored: list[tuple[int, MemoryEntry]] = []
        for entry in all_entries:
            score = 0
            entry_text = f"{entry.content} {' '.join(entry.tags)}"
            entry_tokens = self._tokenize(entry_text)
            for token in query_tokens:
                if token in entry_tokens:
                    score += 1
            if score > 0:
                scored.append((score, entry))
        scored.sort(key=lambda x: x[0], reverse=True)
        return [entry for _, entry in scored[:limit]]

    @staticmethod
    def _tokenize(text: str) -> set[str]:
        """简单分词：英文按空格取词，中文按单字取词，去重并过滤短词。"""
        text_lower = text.lower()
        tokens: set[str] = set()
        # 英文词（按空格分割，取2+字符的词）
        for word in text_lower.split():
            cleaned = "".join(c for c in word if c.isalnum())
            if len(cleaned) >= 2:
                tokens.add(cleaned)
        # 中文字符（每个中文字作为独立token，提高匹配率）
        for c in text_lower:
            if "一" <= c <= "鿿":
                tokens.add(c)
        return tokens

    def _update_index(self, scope: str) -> None:
        """更新 MEMORY.md 索引文件。"""
        memory_dir = (
            self._project_memory_dir if scope == "project" else self._global_memory_dir
        )
        index_path = memory_dir / "MEMORY.md"
        entries: list[str] = []
        for file_path in sorted(memory_dir.glob("*.md")):
            if file_path.name == "MEMORY.md":
                continue
            raw = file_path.read_text(encoding="utf-8")
            meta, content = self._parse_file(raw)
            tags = meta.get("tags", [])
            tag_line = f"**标签:** {', '.join(tags)}\n\n" if tags else ""
            entries.append(f"## {file_path.stem}\n\n{tag_line}{content}\n")
        index_content = "\n".join(entries)
        try:
            with open(index_path, "w", encoding="utf-8") as f:
                try:
                    import fcntl

                    fcntl.flock(f.fileno(), fcntl.LOCK_EX)
                    try:
                        f.write(index_content)
                    finally:
                        fcntl.flock(f.fileno(), fcntl.LOCK_UN)
                except ImportError:
                    f.write(index_content)
        except OSError as exc:
            logger.warning("Failed to update memory index: {exc}", exc=exc)
