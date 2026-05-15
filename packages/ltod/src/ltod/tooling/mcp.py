import mcp.types

import ltod.message


def convert_mcp_content(part: mcp.types.ContentBlock) -> ltod.message.ContentPart:
    """Convert MCP content block to ltod message content part.

    Raises:
        ValueError: If the content type or mime type is not supported.
    """
    match part:
        case mcp.types.TextContent(text=text):
            return ltod.message.TextPart(text=text)
        case mcp.types.ImageContent(data=data, mimeType=mimeType):
            return ltod.message.ImageURLPart(
                image_url=ltod.message.ImageURLPart.ImageURL(url=f"data:{mimeType};base64,{data}")
            )

        case mcp.types.AudioContent(data=data, mimeType=mimeType):
            return ltod.message.AudioURLPart(
                audio_url=ltod.message.AudioURLPart.AudioURL(url=f"data:{mimeType};base64,{data}")
            )
        case mcp.types.EmbeddedResource(
            resource=mcp.types.BlobResourceContents(uri=_uri, mimeType=mimeType, blob=blob)
        ):
            mimeType = mimeType or "application/octet-stream"
            if mimeType.startswith("image/"):
                return ltod.message.ImageURLPart(
                    type="image_url",
                    image_url=ltod.message.ImageURLPart.ImageURL(
                        url=f"data:{mimeType};base64,{blob}",
                    ),
                )
            elif mimeType.startswith("audio/"):
                return ltod.message.AudioURLPart(
                    type="audio_url",
                    audio_url=ltod.message.AudioURLPart.AudioURL(
                        url=f"data:{mimeType};base64,{blob}"
                    ),
                )
            elif mimeType.startswith("video/"):
                return ltod.message.VideoURLPart(
                    type="video_url",
                    video_url=ltod.message.VideoURLPart.VideoURL(
                        url=f"data:{mimeType};base64,{blob}"
                    ),
                )

            else:
                raise ValueError(f"Unsupported mime type: {mimeType}")
        case mcp.types.ResourceLink(uri=uri, mimeType=mimeType, description=_description):
            mimeType = mimeType or "application/octet-stream"
            if mimeType.startswith("image/"):
                return ltod.message.ImageURLPart(
                    type="image_url",
                    image_url=ltod.message.ImageURLPart.ImageURL(url=str(uri)),
                )
            elif mimeType.startswith("audio/"):
                return ltod.message.AudioURLPart(
                    type="audio_url",
                    audio_url=ltod.message.AudioURLPart.AudioURL(url=str(uri)),
                )
            elif mimeType.startswith("video/"):
                return ltod.message.VideoURLPart(
                    type="video_url",
                    video_url=ltod.message.VideoURLPart.VideoURL(url=str(uri)),
                )
            else:
                raise ValueError(f"Unsupported mime type: {mimeType}")
        case _:
            raise ValueError(f"Unsupported MCP tool result part: {part}")
