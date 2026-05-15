# CLI Loading Time

## `src/scream/__init__.py` be empty

**Scope**

`src/scream/__init__.py`

**Requirements**

The `src/scream/__init__.py` file must be empty, containing no code or imports.

## No unnecessary import in `src/scream/cli.py`

**Scope**

`src/scream/cli.py`

**Requirements**

The `src/scream/cli.py` file must not import any modules from `scream` or `ltod`, except for `scream.constant`, at the top level.

## As-needed imports in `src/scream/app.py`

**Scope**

`src/scream/app.py`

**Requirements**

The `src/scream/app.py` file must not import any modules prefixed with `scream.ui` at the top level; instead, UI-specific modules should be imported within functions as needed.

<examples>

```python
# top-level
from scream.ui.shell import ShellApp  # Incorrect: top-level import of UI module

# inside function
async def run_shell_app(...):
    from scream.ui.shell import ShellApp  # Correct: import as needed
    app = ShellApp(...)
    await app.run()
```

</examples>

## `--help` should run fast

**Scope**

No specific source file.

**Requirements**

The time taken to run `uv run scream --help` must be less than 150 milliseconds on average over 5 runs after a 3-run warm-up.
