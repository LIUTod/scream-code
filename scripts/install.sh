#!/usr/bin/env bash
set -euo pipefail

# Detect the user's shell configuration file
_detect_shell_rc() {
  case "$(basename "${SHELL:-bash}")" in
    bash) echo "${HOME}/.bashrc" ;;
    zsh)  echo "${HOME}/.zshrc" ;;
    fish) echo "${HOME}/.config/fish/config.fish" ;;
    *)    echo "" ;;
  esac
}

# Common uv installation paths
_UV_PATHS=(
  "${HOME}/.cargo/bin/uv"
  "${HOME}/.local/bin/uv"
  "/usr/local/bin/uv"
)

_find_uv() {
  # First, check if uv is on PATH
  if command -v uv >/dev/null 2>&1; then
    command -v uv
    return 0
  fi
  # Then check common installation paths
  for p in "${_UV_PATHS[@]}"; do
    if [[ -x "$p" ]]; then
      echo "$p"
      return 0
    fi
  done
  return 1
}

_install_uv() {
  echo "Installing uv (Python package manager)..."

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://astral.sh/uv/install.sh | sh
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- https://astral.sh/uv/install.sh | sh
  else
    echo "Error: curl or wget is required to install uv." >&2
    exit 1
  fi

  # uv installer adds itself to shell rc; source it for the current session
  local uv_bin
  uv_bin="$(_find_uv)"
  if [[ -n "$uv_bin" ]]; then
    echo "$uv_bin"
    return 0
  fi

  # If still not found, try to locate it in the expected paths
  for p in "${_UV_PATHS[@]}"; do
    if [[ -x "$p" ]]; then
      echo "$p"
      return 0
    fi
  done

  echo "Error: uv was installed but could not be found." >&2
  echo "Please restart your terminal and try again." >&2
  exit 1
}

UV_BIN="$(_find_uv)" || UV_BIN=""

if [[ -z "$UV_BIN" ]]; then
  UV_BIN="$(_install_uv)"
fi

echo "Installing scream-code (this may take a few minutes)..."
"$UV_BIN" tool install git+https://github.com/LIUTod/scream-code

# Check if uv tool bin dir is on PATH
_UV_TOOL_DIR="${HOME}/.local/bin"
if [[ ":$PATH:" != *":${_UV_TOOL_DIR}:"* ]]; then
  echo ""
  echo "========================================"
  echo "Installation complete!"
  echo ""
  echo "One more step: add the following line to your shell profile"
  echo "so that the 'scream' command is available in new terminals:"
  echo ""
  local _rc
  _rc="$(_detect_shell_rc)"
  if [[ -n "$_rc" ]]; then
    echo "  echo 'export PATH=\"${_UV_TOOL_DIR}:\$PATH\"' >> ${_rc}"
    echo ""
    echo "Then run: source ${_rc}"
  else
    echo "  export PATH=\"${_UV_TOOL_DIR}:\$PATH\""
  fi
  echo ""
  echo "Or you can run it directly now:"
  echo "  ${_UV_TOOL_DIR}/scream"
  echo "========================================"
else
  echo ""
  echo "Installation complete! Run 'scream' to start."
fi
