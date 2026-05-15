from __future__ import annotations

from ltod.message import Message

from scream.wire.types import AudioURLPart, ImageURLPart, TextPart, VideoURLPart


def message_stringify(message: Message) -> str:
    """Get a string representation of a message."""
    # TODO: this should be merged into `ltod.message.Message.extract_text`
    parts: list[str] = []
    for part in message.content:
        if isinstance(part, TextPart):
            parts.append(part.text)
        elif isinstance(part, ImageURLPart):
            parts.append("[image]")
        elif isinstance(part, AudioURLPart):
            suffix = f":{part.audio_url.id}" if part.audio_url.id else ""
            parts.append(f"[audio{suffix}]")
        elif isinstance(part, VideoURLPart):
            parts.append("[video]")
        else:
            parts.append(f"[{part.type}]")
    return "".join(parts)
