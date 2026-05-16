from __future__ import annotations

import asyncio
import json
from collections.abc import Sequence
from typing import TYPE_CHECKING

from ltod.chat_provider import ChatProvider
from ltod.message import Message, TextPart

from scream.memory import MemoryManager
from scream.memory.models import MemoryEntry
from scream.utils.logging import logger

if TYPE_CHECKING:
    pass

_SUMMARY_SYSTEM_PROMPT = (
    '将对话总结为JSON：{"title":"10字标题","content":"详细总结","tags":["标签"]}\n'
    "要求：标题简洁，content包含关键信息，tags分类。只用中文。"
)

_MIN_TURN_LENGTH = 50
"""Minimum combined length of user + assistant text to trigger auto-save."""

_MAX_MESSAGES_FOR_SUMMARY = 20
"""Max number of messages to include in summarization."""

_MAX_MESSAGE_LEN = 400
"""Max characters per individual message before truncation."""

_SUMMARY_TIMEOUT_S = 10.0
"""Timeout for the LLM summary call."""


def _extract_text(messages: Sequence[Message]) -> str:
    """Extract plain text from a sequence of messages, truncated if too long.

    Truncation strategy:
    1. Each message is capped at _MAX_MESSAGE_LEN to preserve all messages' presence.
    2. If total messages exceed _MAX_MESSAGES_FOR_SUMMARY, keep first and last halves
       with an ellipsis marker in between.
    """
    parts: list[str] = []
    for msg in messages:
        if msg.role not in ("user", "assistant"):
            continue
        text = ""
        for part in msg.content:
            if isinstance(part, TextPart):
                text += part.text
        stripped = text.strip()
        if stripped:
            if len(stripped) > _MAX_MESSAGE_LEN:
                stripped = stripped[:_MAX_MESSAGE_LEN] + "\n...[truncated]..."
            parts.append(f"[{msg.role}] {stripped}")

    # If too many messages, keep first and last portions to preserve context range
    if len(parts) > _MAX_MESSAGES_FOR_SUMMARY:
        half = _MAX_MESSAGES_FOR_SUMMARY // 2
        head = parts[:half]
        tail = parts[-half:]
        parts = head + ["\n...[省略中间消息]...\n"] + tail

    return "\n\n".join(parts)


def _jaccard_similarity(a: str, b: str) -> float:
    """Compute Jaccard similarity between two strings using simple tokenization."""
    from scream.memory.manager import MemoryManager as _MM

    tokens_a = _MM._tokenize(a)
    tokens_b = _MM._tokenize(b)
    if not tokens_a and not tokens_b:
        return 1.0
    if not tokens_a or not tokens_b:
        return 0.0
    intersection = len(tokens_a & tokens_b)
    union = len(tokens_a | tokens_b)
    return intersection / union


def _find_duplicate(
    content: str, manager: MemoryManager, threshold: float = 0.6
) -> MemoryEntry | None:
    """Find a similar existing memory entry."""
    # Check both short-term and long-term to avoid duplicates across tiers
    for entry in manager.list_entries(filter="short") + manager.list_entries(
        filter="long"
    ):
        combined = f"{entry.content} {' '.join(entry.tags)}"
        if _jaccard_similarity(content, combined) >= threshold:
            return entry
    return None


async def summarize_turn(
    chat_provider: ChatProvider,
    turn_messages: Sequence[Message],
) -> dict[str, str | list[str]] | None:
    """Use LLM to summarize a turn into a memory entry.

    Returns:
        A dict with 'title', 'content', 'tags' keys, or None if summarization failed.
    """
    conversation_text = _extract_text(turn_messages)
    if len(conversation_text) < _MIN_TURN_LENGTH:
        return None

    history = [
        Message(role="user", content=[TextPart(text=conversation_text)]),
    ]

    try:
        stream = await asyncio.wait_for(
            chat_provider.generate(_SUMMARY_SYSTEM_PROMPT, [], history),
            timeout=_SUMMARY_TIMEOUT_S,
        )
    except TimeoutError:
        logger.warning(
            "Memory summarization timed out after {timeout}s",
            timeout=_SUMMARY_TIMEOUT_S,
        )
        return None
    except Exception as exc:
        logger.warning("Memory summarization failed: {error}", error=exc)
        return None

    # Collect all text parts from the stream
    text_parts: list[str] = []
    try:
        async for part in stream:
            if isinstance(part, TextPart):
                text_parts.append(part.text)
    except Exception as exc:
        logger.warning("Memory summarization stream failed: {error}", error=exc)
        return None

    raw = "".join(text_parts).strip()
    if not raw:
        return None

    # Try to extract JSON from the response
    # The model may wrap JSON in markdown code blocks or add extra text
    json_text = raw
    # Find the outermost JSON object by locating first { and last }
    try:
        start_idx = raw.index("{")
        end_idx = raw.rindex("}")
        json_text = raw[start_idx:end_idx + 1]
    except ValueError:
        pass  # No braces found, use raw text

    try:
        data = json.loads(json_text)
        return {
            "title": str(data.get("title", "")),
            "content": str(data.get("content", "")),
            "tags": [str(t) for t in data.get("tags", [])],
        }
    except json.JSONDecodeError:
        # Fallback: use the raw text as content
        logger.debug("Memory summarization returned non-JSON: {raw}", raw=raw[:200])
        return {
            "title": "对话记录",
            "content": raw,
            "tags": [],
        }


async def auto_save_turn(
    chat_provider: ChatProvider,
    memory_manager: MemoryManager,
    turn_messages: Sequence[Message],
) -> MemoryEntry | None:
    """Auto-save a turn to memory after summarization.

    Returns:
        The saved MemoryEntry, or None if saving was skipped or failed.
    """
    summary = await summarize_turn(chat_provider, turn_messages)
    if summary is None:
        return None

    # Check for duplicates
    existing = _find_duplicate(
        f"{summary['title']} {summary['content']}", memory_manager
    )
    if existing is not None:
        logger.debug(
            "Skipping duplicate memory: similar to {entry_id}", entry_id=existing.id
        )
        return None

    tags = summary["tags"]
    if isinstance(tags, str):
        tags = [tags]
    entry = memory_manager.add_entry(
        content=f"## {summary['title']}\n\n{summary['content']}",
        tags=tags,  # type: ignore[arg-type]
        scope="project",
        short_term=True,
    )
    logger.info(
        "Auto-saved memory: {title} ({entry_id})",
        title=summary["title"],
        entry_id=entry.id,
    )
    return entry
