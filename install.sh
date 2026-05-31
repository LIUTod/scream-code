#!/usr/bin/env bash
# Scream Code 一键安装 (TypeScript 版)
# 前置: Node.js >= 24.15.0, Git
# 国内用户请先开启科学上网

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

# ── 1. 检测 Node.js >= 24.15.0 ─────────────────────────────────────────────
find_node() {
    for cmd in node nodejs node24 node25; do
        if command -v "$cmd" >/dev/null 2>&1; then
            ver_output=$($cmd --version 2>&1 | sed 's/^v//')
            if [[ "$ver_output" =~ ^([0-9]+)\.([0-9]+)\. ]]; then
                major="${BASH_REMATCH[1]}"
                minor="${BASH_REMATCH[2]}"
                # 需要 >= 24.15
                if [[ "$major" -gt 24 ]] || { [[ "$major" -eq 24 ]] && [[ "$minor" -ge 15 ]]; }; then
                    echo "$cmd"
                    return 0
                fi
            fi
        fi
    done
    return 1
}

info "检测 Node.js >= 24.15.0..."
NODE_CMD=$(find_node) || {
    error "未找到 Node.js 24.15.0 或更高版本"
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
    # 优先尝试 corepack (Node >= 16.13 内置)
    if $NODE_CMD -e "process.exit(require('module').createRequire(import.meta.url)('child_process').execSync('corepack --version', {encoding:'utf8'}).trim() ? 0 : 1)" 2>/dev/null || command -v corepack >/dev/null 2>&1; then
        corepack enable 2>/dev/null || true
    fi
    # 如果 corepack 没成功，使用 standalone installer
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

# ── 4. 确认安装路径 ────────────────────────────────────────────────────────
info "安装路径: $INSTALL_DIR"

# ── 5. 下载 / 升级项目 ─────────────────────────────────────────────────────
if [[ "$UPGRADE_MODE" == true ]] && [[ -d "$SCREAM_HOME/.git" ]] && [[ "$FORCE_MODE" == false ]]; then
    info "检测到现有安装，执行升级..."
    cd "$SCREAM_HOME"
    git pull origin main || git pull origin master || {
        error "git pull 失败"
        exit 1
    }
elif [[ -d "$SCREAM_HOME" ]] && [[ "$FORCE_MODE" == false ]] && [[ "$UPGRADE_MODE" == false ]]; then
    warn "目录已存在: $SCREAM_HOME"
    warn "如需升级现有安装，请使用: ./install.sh --upgrade"
    warn "如需强制重新安装，请使用: ./install.sh --force"
    exit 1
else
    info "下载 scream-code..."
    rm -rf "$SCREAM_HOME"
    git clone --depth 1 "https://github.com/$REPO.git" "$SCREAM_HOME" || {
        error "下载失败"
        echo "请检查网络连接（国内用户需要科学上网）"
        exit 1
    }
    cd "$SCREAM_HOME"
fi

# 确保在仓库目录中
cd "$SCREAM_HOME"

# ── 6. 安装依赖并构建 ──────────────────────────────────────────────────────
info "安装依赖并构建..."
pnpm install || {
    error "依赖安装失败"
    exit 1
}
pnpm -r build || {
    error "构建失败"
    exit 1
}

# ── 7. 创建 scream 命令 ────────────────────────────────────────────────────
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/scream" <<'EOF'
#!/usr/bin/env bash
SCREAM_HOME="${SCREAM_HOME:-$HOME/.scream-code}"
cd "$SCREAM_HOME"
exec node "$SCREAM_HOME/apps/scream-code/dist/main.mjs" "$@"
EOF
chmod +x "$BIN_DIR/scream"

# ── 8. 添加到 PATH ─────────────────────────────────────────────────────────
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
