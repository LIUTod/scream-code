# ltod

ltod is an LLM abstraction layer designed for modern AI agent applications. It unifies message structures, asynchronous tool orchestration, and pluggable chat providers so you can build agents with ease and avoid vendor lock-in.

- **GitHub**: https://github.com/LIUTod/scream-code

## Installation

ltod requires Python 3.12 or higher. We recommend using uv as the package manager.

Init your project with:

```bash
uv init --python 3.12  # or higher
```

Then add ltod as a dependency:

```bash
uv add ltod
```

To enable chat providers other than the default (e.g. Anthropic and Google Gemini), install the optional extra:

```bash
uv add 'ltod[contrib]'
```

> **Configuration note**: ltod does not bind to any fixed API endpoint. The `base_url`, `api_key`, and `model` are all user-configurable. Pass them explicitly when constructing the chat provider, or set the corresponding environment variables.

## Examples

### Simple chat completion

```python
import asyncio

import ltod
from ltod.chat_provider.scream import Scream
from ltod.message import Message


async def main() -> None:
    client = Scream(
        api_key="your_scream_api_key_here",
        model="scream-for-coding",
    )

    history = [
        Message(role="user", content="Who are you?"),
    ]

    result = await ltod.generate(
        chat_provider=client,
        system_prompt="You are a helpful assistant.",
        tools=[],
        history=history,
    )
    print(result.message)
    print(result.usage)


asyncio.run(main())
```

### Streaming output

```python
import asyncio

import ltod
from ltod.chat_provider import StreamedMessagePart
from ltod.chat_provider.scream import Scream
from ltod.message import Message


async def main() -> None:
    client = Scream(
        api_key="your_scream_api_key_here",
        model="scream-for-coding",
    )

    history = [
        Message(role="user", content="Who are you?"),
    ]

    def output(message_part: StreamedMessagePart):
        print(message_part)

    result = await ltod.generate(
        chat_provider=client,
        system_prompt="You are a helpful assistant.",
        tools=[],
        history=history,
        on_message_part=output,
    )
    print(result.message)
    print(result.usage)


asyncio.run(main())
```

### Tool calling with `ltod.step`

```python
import asyncio

from pydantic import BaseModel

import ltod
from ltod import StepResult
from ltod.chat_provider.scream import Scream
from ltod.message import Message
from ltod.tooling import CallableTool2, ToolOk, ToolReturnValue
from ltod.tooling.simple import SimpleToolset


class AddToolParams(BaseModel):
    a: int
    b: int


class AddTool(CallableTool2[AddToolParams]):
    name: str = "add"
    description: str = "Add two integers."
    params: type[AddToolParams] = AddToolParams

    async def __call__(self, params: AddToolParams) -> ToolReturnValue:
        return ToolOk(output=str(params.a + params.b))


async def main() -> None:
    client = Scream(
        api_key="your_scream_api_key_here",
        model="scream-for-coding",
    )

    toolset = SimpleToolset()
    toolset += AddTool()

    history = [
        Message(role="user", content="Please add 2 and 3 with the add tool."),
    ]

    result: StepResult = await ltod.step(
        chat_provider=client,
        system_prompt="You are a precise math tutor.",
        toolset=toolset,
        history=history,
    )
    print(result.message)
    print(await result.tool_results())


asyncio.run(main())
```

## Builtin Demo

ltod comes with a builtin demo agent that you can run locally. Before starting, configure your own API endpoint and key:

```sh
# User-configurable API endpoint (required)
export SCREAM_BASE_URL="<your-api-base-url>"
export SCREAM_API_KEY="your_scream_api_key"

uv run python -m ltod scream --with-bash
```

## Development

Source code: https://github.com/LIUTod/scream-code

To set up a development environment, install the dependencies and run the checks:

```bash
uv sync --all-extras

make check  # run lint and type checks
make test   # run tests
make format # format code
```
