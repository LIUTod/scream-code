from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class MemoryEntry:
    """单条记忆条目。"""

    id: str
    content: str
    tags: list[str] = field(default_factory=list[str])
    created_at: str = ""
    updated_at: str = ""
    source: str = ""  # "project" or "global"

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "content": self.content,
            "tags": self.tags,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "source": self.source,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> MemoryEntry:
        return cls(
            id=data.get("id", ""),
            content=data.get("content", ""),
            tags=data.get("tags", []),
            created_at=data.get("created_at", ""),
            updated_at=data.get("updated_at", ""),
            source=data.get("source", ""),
        )
