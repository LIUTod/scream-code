from __future__ import annotations

import sys
from collections.abc import Sequence

from scream.cli import cli


def main(argv: Sequence[str] | None = None) -> int | str | None:
    from scream.telemetry.crash import install_crash_handlers, set_phase
    from scream.utils.environment import GitBashNotFoundError
    from scream.utils.proxy import normalize_proxy_env

    # Same entry treatment as scream.__main__: install excepthook before
    # anything else so startup-phase crashes in subcommand subprocesses
    # (background-task-worker, __web-worker, acp via toad) are captured.
    install_crash_handlers()
    normalize_proxy_env()

    try:
        if argv is None:
            return cli()
        return cli(args=list(argv))
    except SystemExit as exc:
        return exc.code
    except GitBashNotFoundError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    finally:
        set_phase("shutdown")


if __name__ == "__main__":
    raise SystemExit(main())
