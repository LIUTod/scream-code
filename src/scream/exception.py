from __future__ import annotations


class ScreamCLIException(Exception):
    """Base exception class for Scream Code CLI."""

    pass


class ConfigError(ScreamCLIException, ValueError):
    """Configuration error."""

    pass


class AgentSpecError(ScreamCLIException, ValueError):
    """Agent specification error."""

    pass


class InvalidToolError(ScreamCLIException, ValueError):
    """Invalid tool error."""

    pass


class SystemPromptTemplateError(ScreamCLIException, ValueError):
    """System prompt template error."""

    pass


class MCPConfigError(ScreamCLIException, ValueError):
    """MCP config error."""

    pass


class MCPRuntimeError(ScreamCLIException, RuntimeError):
    """MCP runtime error."""

    pass
