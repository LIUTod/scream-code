Generate or edit an image through the locally configured image API (OpenAI-compatible) and save the result as a PNG file. Returns the absolute path of the saved image.

- `mode=new`: text-to-image generation from `prompt`.
- `mode=edit`: rewrites the image(s) listed in `imagePaths` (at least one required).
- `mode=continue`: edits the last image produced in the session; extra `imagePaths` are fed in as additional references.
- `session` groups turns into one visual thread; omit it to start or join the default thread.
- `size` defaults to the configured value (usually omitted from the request). If the service rejects an explicit size or demands one, the tool retries once on its own — no need to repeat the call.
- The configured URL is the FULL endpoint and is used verbatim; nothing is appended. Image editing uses the configured edit URL, or derives the sibling `/images/edits` endpoint when the main URL ends in `/images/generations`.
- Input image paths go through the same path policy as Read before any request: sensitive files (credentials, SSH keys, env files) are rejected outright, and relative paths may not escape the workspace. Rejections happen before approval and before any bytes leave the machine.
- The API configuration lives only in a local file on this machine. When the tool reports that image generation is not configured, tell the user to run `/config image` and retry after they finish — never ask for, repeat, or log an API key in the conversation.
- Call this with the prompt passed through unchanged: use the user's own wording — do not rewrite, expand, or add style/lighting/composition details. Size and aspect-ratio needs belong in `size`. Refine the prompt only when the user explicitly asks for a rewrite.
