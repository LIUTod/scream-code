#!/usr/bin/env bash
# Scream Code 一键安装 (TypeScript 版)
# 前置: Node.js >= 22.0.0, Git
# 国内用户建议科学上网，如遇网络错误请多尝试几次

set -euo pipefail

# 参数解析
UPGRADE_MODE=false
FORCE_MODE=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --upgrade) UPGRADE_MODE=true; shift ;;
        --force)   FORCE_MODE=true;   shift ;;
        *)         shift ;;
    esac
done

REPO="LIUTod/scream-code"
DEFAULT_DIR="${HOME}/.scream-code"
INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_DIR}"
BIN_DIR="$INSTALL_DIR/bin"
SCREAM_HOME="$INSTALL_DIR"

info()  { echo "[INFO]  $*"; }
warn()  { echo "[WARN]  $*" >&2; }
error() { echo "[ERROR] $*" >&2; }

# ══════════════════════════════════════════════════════════════════════════════
# 0. 彻底清理所有旧版本 scream（Python / pip / uv），确保全新安装不冲突
# ══════════════════════════════════════════════════════════════════════════════
info "清理旧 scream 版本..."

# ── 删除所有已知位置的旧 scream 命令 ──
for dir in \
    "$HOME/.scream-code/bin" \
    "$HOME/.local/bin" \
    "/usr/local/bin" \
    "/opt/homebrew/bin"; do
    if [ -f "$dir/scream" ]; then
        rm -f "$dir/scream"
        info "已删除旧命令: $dir/scream"
    fi
done

# ── 卸载 pip / pipx / uv 全局安装的旧 scream 包 ──
for pip_cmd in pip3 pip; do
    if command -v "$pip_cmd" >/dev/null 2>&1; then
        "$pip_cmd" uninstall -y scream 2>/dev/null || true
    fi
done
if command -v pipx >/dev/null 2>&1; then
    pipx uninstall scream 2>/dev/null || true
fi
if command -v uv >/dev/null 2>&1; then
    uv tool uninstall scream 2>/dev/null || true
fi
# 清理 uv 可能残留的 trampoline 脚本
rm -f "$HOME/.local/bin/scream" 2>/dev/null || true

# ── 彻底删除旧 scream-code 目录（Python .venv / node_modules 等） ──
if [ -d "$INSTALL_DIR" ]; then
    info "删除旧安装目录: $INSTALL_DIR"
    rm -rf "$INSTALL_DIR"
fi

# ── 清理 shell 配置中的所有旧 scream-code PATH 条目 ──
for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.zprofile"; do
    if [ -f "$rc" ]; then
        sed -i.bak '/\.scream-code\/bin/d' "$rc" 2>/dev/null || true
        sed -i.bak '/scream-code.*PATH/d' "$rc" 2>/dev/null || true
        rm -f "${rc}.bak" 2>/dev/null || true
    fi
done
info "旧版本清理完毕"

# ══════════════════════════════════════════════════════════════════════════════
# 1. 检测 Node.js >= 22.0.0
# ══════════════════════════════════════════════════════════════════════════════
find_node() {
    for cmd in node nodejs node22 node24 node25; do
        if command -v "$cmd" >/dev/null 2>&1; then
            ver_output=$($cmd --version 2>&1 | sed 's/^v//')
            if [[ "$ver_output" =~ ^([0-9]+)\.([0-9]+)\. ]]; then
                major="${BASH_REMATCH[1]}"
                minor="${BASH_REMATCH[2]}"
                if [[ "$major" -gt 22 ]] || { [[ "$major" -eq 22 ]] && [[ "$minor" -ge 0 ]]; }; then
                    echo "$cmd"
                    return 0
                fi
            fi
        fi
    done
    return 1
}

info "检测 Node.js >= 22.0.0..."
NODE_CMD=$(find_node) || {
    error "未找到 Node.js 22.0.0 或更高版本"
    echo ""
    echo "安装方式："
    echo "  macOS:    brew install node"
    echo "  通用:     https://nodejs.org/ 下载 LTS 版"
    echo ""
    exit 1
}
info "Node.js: $($NODE_CMD --version)"

# ── 2. 检测 Git ────────────────────────────────────────────────────────────
info "检测 Git..."
if ! command -v git >/dev/null 2>&1; then
    error "未找到 Git"
    echo ""
    echo "安装方式："
    echo "  macOS:    brew install git"
    echo "  Ubuntu:   sudo apt install git"
    echo "  其他:     https://git-scm.com/downloads"
    echo ""
    exit 1
fi
info "Git: $(git --version)"

# ── 3. 检测 / 安装 pnpm ────────────────────────────────────────────────────
info "检测 pnpm..."
if ! command -v pnpm >/dev/null 2>&1; then
    info "pnpm 未安装，正在自动安装..."
    if $NODE_CMD -e "process.exit(require('module').createRequire(import.meta.url)('child_process').execSync('corepack --version', {encoding:'utf8'}).trim() ? 0 : 1)" 2>/dev/null || command -v corepack >/dev/null 2>&1; then
        corepack enable 2>/dev/null || true
    fi
    if ! command -v pnpm >/dev/null 2>&1; then
        curl -fsSL https://get.pnpm.io/install.sh | sh - || {
            error "pnpm 安装失败"
            echo "请手动安装: https://pnpm.io/installation"
            exit 1
        }
        export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
    fi
fi
info "pnpm: $(pnpm --version)"

# ── 4. 下载项目 ─────────────────────────────────────────────────────────────
info "安装路径: $INSTALL_DIR"
info "下载 scream-code..."
git clone --depth 1 "https://github.com/$REPO.git" "$INSTALL_DIR" || {
    error "下载失败"
    echo "请检查网络连接（国内用户建议科学上网，或稍后重试）"
    exit 1
}
cd "$INSTALL_DIR"

# ── 5. 安装依赖并构建 ──────────────────────────────────────────────────────
info "安装依赖并构建..."
pnpm install || {
    error "依赖安装失败"
    exit 1
}
pnpm -r build || {
    error "构建失败"
    exit 1
}

# ── 6. 创建 scream 命令 ────────────────────────────────────────────────────
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/scream" <<'EOF'
#!/usr/bin/env bash
SCREAM_HOME="${SCREAM_HOME:-$HOME/.scream-code}"
cd "$SCREAM_HOME"
exec node "$SCREAM_HOME/apps/scream-code/dist/main.mjs" "$@"
EOF
chmod +x "$BIN_DIR/scream"

# ── 7. 添加到 PATH ─────────────────────────────────────────────────────────
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
    SHELL_RC=""
    if [ -n "${ZSH_VERSION:-}" ] || [ "$(basename "$SHELL")" = "zsh" ]; then
        SHELL_RC="$HOME/.zshrc"
    elif [ -n "${BASH_VERSION:-}" ] || [ "$(basename "$SHELL")" = "bash" ]; then
        SHELL_RC="$HOME/.bashrc"
    fi

    if [ -n "$SHELL_RC" ] && [ -f "$SHELL_RC" ]; then
        echo "export PATH=\"$BIN_DIR:\$PATH\"" >> "$SHELL_RC"
        info "已自动将 $BIN_DIR 加入 PATH ($SHELL_RC)"
    else
        echo ""
        echo "请手动添加以下到 shell 配置文件 (~/.bashrc 或 ~/.zshrc):"
        echo "  export PATH=\"$BIN_DIR:\$PATH\""
    fi
fi

export PATH="$BIN_DIR:$PATH"

info "安装完成！"
echo ""
echo "安装位置: $INSTALL_DIR"
echo "运行:     scream --version"
echo ""
echo "如果命令找不到，请重新打开终端或执行: source ~/.bashrc (或 ~/.zshrc)"
