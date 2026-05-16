from __future__ import annotations

import datetime
import json
import uuid
from pathlib import Path
from typing import Any

from scream.memory.models import MemoryEntry
from scream.utils.logging import logger


class MemoryManager:
    """记忆管理器 — 短期记忆(48h自动清理) + 长期记忆 + 全局记忆。"""

    def __init__(
        self, work_dir: Path, share_dir: Path, *, ttl_hours: int = 48
    ) -> None:
        self._work_dir = work_dir
        self._share_dir = share_dir
        self._ttl_hours = ttl_hours

        # 新目录结构: .scream/memory/short-term/ + long-term/
        self._short_term_dir = work_dir / ".scream" / "memory" / "short-term"
        self._long_term_dir = work_dir / ".scream" / "memory" / "long-term"
        self._global_memory_dir = share_dir / "memory"

        self._short_term_dir.mkdir(parents=True, exist_ok=True)
        self._long_term_dir.mkdir(parents=True, exist_ok=True)
        self._global_memory_dir.mkdir(parents=True, exist_ok=True)

        # 向后兼容: 旧格式 .md 文件(直接在 memory/ 下)迁移到 long-term/
        self._migrate_legacy_files()
        # 启动时清理过期短期记忆
        self.cleanup_expired()

    def _migrate_legacy_files(self) -> None:
        """将旧格式的 .md 文件从 memory/ 迁移到 memory/long-term/。"""
        legacy_dir = self._work_dir / ".scream" / "memory"
        if not legacy_dir.exists():
            return
        md_files = [
            f for f in legacy_dir.glob("*.md")
            if f.name != "MEMORY.md" and f.parent == legacy_dir
        ]
        if not md_files:
            return
        logger.info(
            "Migrating {count} legacy memory files to long-term/",
            count=len(md_files),
        )
        for f in md_files:
            try:
                f.rename(self._long_term_dir / f.name)
            except OSError as exc:
                logger.warning("Failed to migrate {file}: {exc}", file=f.name, exc=exc)
        self._update_index("long-term")

    def add_entry(
        self,
        content: str,
        tags: list[str] | None = None,
        scope: str = "project",
        short_term: bool = False,
    ) -> MemoryEntry:
        """添加记忆条目。short_term=True 时保存到短期区并设置48h过期。"""
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

        if scope == "global":
            memory_dir = self._global_memory_dir
        elif short_term:
            memory_dir = self._short_term_dir
            entry.source = "short-term"
        else:
            memory_dir = self._long_term_dir
            entry.source = "long-term"

        file_path = memory_dir / f"{entry_id}.md"
        meta: dict[str, Any] = {
            "tags": entry.tags,
            "created_at": entry.created_at,
            "updated_at": entry.updated_at,
        }
        if short_term and scope != "global":
            expires = datetime.datetime.now() + datetime.timedelta(hours=self._ttl_hours)
            meta["expires_at"] = expires.isoformat()

        file_body = f"---\n{json.dumps(meta, ensure_ascii=False)}\n---\n{content}"
        file_path.write_text(file_body, encoding="utf-8")

        scope_key = "global" if scope == "global" else ("short-term" if short_term else "long-term")
        self._update_index(scope_key)
        return entry

    def remove_entry(
        self, entry_id: str, scope: str | None = None, *, filter: str | None = None
    ) -> bool:
        """删除记忆条目。若未指定 scope/filter，自动在所有目录查找。"""
        dirs_to_check: list[tuple[str, Path]] = [
            ("short-term", self._short_term_dir),
            ("long-term", self._long_term_dir),
            ("global", self._global_memory_dir),
        ]
        filter_type = filter if filter is not None else scope
        if filter_type and filter_type != "all":
            scope_map = {
                "short": "short-term",
                "short-term": "short-term",
                "long": "long-term",
                "long-term": "long-term",
                "global": "global",
            }
            mapped = scope_map.get(filter_type, filter_type)
            dirs_to_check = [(mapped, d) for s, d in dirs_to_check if s == mapped]

        for s, memory_dir in dirs_to_check:
            file_path = memory_dir / f"{entry_id}.md"
            if file_path.exists():
                file_path.unlink()
                self._update_index(s)
                return True
        return False

    def list_entries(
        self, scope: str | None = None, filter: str = "all"
    ) -> list[MemoryEntry]:
        """列出记忆条目。

        Args:
            scope: 兼容旧接口，留空时由 filter 控制。
            filter: "short" | "long" | "global" | "all"，默认 "all"。
        """
        entries: list[MemoryEntry] = []
        filters = []
        if scope and scope != "all":
            # 旧接口兼容
            scope_map: dict[str, list[str]] = {
                "project": ["short-term", "long-term"],
                "global": ["global"],
            }
            filters = scope_map.get(scope, ["short-term", "long-term", "global"])
        else:
            filter_map: dict[str, list[str]] = {
                "short": ["short-term"],
                "long": ["long-term"],
                "global": ["global"],
                "all": ["short-term", "long-term", "global"],
            }
            filters = filter_map.get(filter, ["short-term", "long-term", "global"])

        dir_map: dict[str, Path] = {
            "short-term": self._short_term_dir,
            "long-term": self._long_term_dir,
            "global": self._global_memory_dir,
        }

        for f in filters:
            memory_dir = dir_map[f]
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
                    source=f,
                )
                entries.append(entry)
        return entries

    def find_relevant(
        self, query: str, limit: int = 5, search_scope: str = "all"
    ) -> list[MemoryEntry]:
        """关键词匹配搜索相关记忆。支持跨 short/long/global 搜索。"""
        query_tokens = self._tokenize(query)
        if not query_tokens:
            return []
        all_entries = self.list_entries(filter=search_scope)
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

    def promote_to_long_term(self, entry_id: str) -> MemoryEntry | None:
        """将短期记忆提升为长期记忆。"""
        src_path = self._short_term_dir / f"{entry_id}.md"
        if not src_path.exists():
            return None

        raw = src_path.read_text(encoding="utf-8")
        meta, content = self._parse_file(raw)
        now = datetime.datetime.now().isoformat()

        # 移除 expires_at，更新 updated_at
        meta.pop("expires_at", None)
        meta["updated_at"] = now

        dst_path = self._long_term_dir / f"{entry_id}.md"
        file_body = f"---\n{json.dumps(meta, ensure_ascii=False)}\n---\n{content}"
        dst_path.write_text(file_body, encoding="utf-8")
        src_path.unlink()

        self._update_index("short-term")
        self._update_index("long-term")

        return MemoryEntry(
            id=entry_id,
            content=content,
            tags=meta.get("tags", []),
            created_at=meta.get("created_at", ""),
            updated_at=now,
            source="long-term",
        )

    def cleanup_expired(self) -> int:
        """清理过期的短期记忆，返回删除数量。"""
        now = datetime.datetime.now()
        deleted = 0
        dirs_to_check: list[tuple[str, Path]] = [
            ("short-term", self._short_term_dir),
            ("global", self._global_memory_dir),
        ]
        for _scope_key, memory_dir in dirs_to_check:
            if not memory_dir.exists():
                continue
            for file_path in memory_dir.glob("*.md"):
                if file_path.name in ("MEMORY.md", ".index.lock"):
                    continue
                try:
                    raw = file_path.read_text(encoding="utf-8")
                    meta, _ = self._parse_file(raw)
                    expires = meta.get("expires_at")
                    if expires:
                        expires_dt = datetime.datetime.fromisoformat(expires)
                        if now > expires_dt:
                            file_path.unlink()
                            deleted += 1
                except (OSError, ValueError):
                    continue
        if deleted > 0:
            self._update_index("short-term")
            self._update_index("global")
            logger.info("Cleaned up {count} expired short-term memories", count=deleted)
        return deleted

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

    @staticmethod
    def _tokenize(text: str) -> set[str]:
        """简单分词：英文按空格取词，中文按单字取词，去重并过滤短词。"""
        text_lower = text.lower()
        tokens: set[str] = set()
        # 英文词和数字（按空格分割，取2+字符的词；纯数字也保留）
        for word in text_lower.split():
            cleaned = "".join(c for c in word if c.isalnum())
            if len(cleaned) >= 2 or cleaned.isdigit():
                tokens.add(cleaned)
        # 中文字符（每个中文字作为独立token，提高匹配率）
        for c in text_lower:
            if "一" <= c <= "鿿":
                tokens.add(c)
        return tokens

    @staticmethod
    def _lock_file(lock_f: Any) -> None:
        try:
            import fcntl

            fcntl.flock(lock_f.fileno(), fcntl.LOCK_EX)
        except ImportError:
            pass

    @staticmethod
    def _unlock_file(lock_f: Any) -> None:
        try:
            import fcntl

            fcntl.flock(lock_f.fileno(), fcntl.LOCK_UN)
        except ImportError:
            pass

    def _update_index(self, scope: str) -> None:
        """更新 MEMORY.md 索引文件。"""
        dir_map: dict[str, Path] = {
            "short-term": self._short_term_dir,
            "long-term": self._long_term_dir,
            "global": self._global_memory_dir,
        }
        memory_dir = dir_map.get(scope)
        if memory_dir is None:
            return
        index_path = memory_dir / "MEMORY.md"
        lock_path = memory_dir / ".index.lock"
        try:
            # Directory-level lock: protects the entire read-build-write cycle
            with open(lock_path, "w", encoding="utf-8") as lock_f:
                self._lock_file(lock_f)
                try:
                    entries: list[str] = []
                    for file_path in sorted(memory_dir.glob("*.md")):
                        if file_path.name in ("MEMORY.md", ".index.lock"):
                            continue
                        raw = file_path.read_text(encoding="utf-8")
                        meta, content = self._parse_file(raw)
                        tags = meta.get("tags", [])
                        tag_line = f"**标签:** {', '.join(tags)}\n\n" if tags else ""
                        entries.append(f"## {file_path.stem}\n\n{tag_line}{content}\n")
                    index_path.write_text("\n".join(entries), encoding="utf-8")
                finally:
                    self._unlock_file(lock_f)
        except OSError as exc:
            logger.warning("Failed to update memory index: {exc}", exc=exc)
