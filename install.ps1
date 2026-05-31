# Scream Code 一键安装 (TypeScript 版 / Windows)
# 前置: Node.js >= 24.15.0 + Git
# 国内用户请先开启科学上网

$ErrorActionPreference = "Stop"

$Repo       = "LIUTod/scream-code"
$DefaultDir = "$env:USERPROFILE\scream-code"
$InstallDir = if ($env:INSTALL_DIR) { $env:INSTALL_DIR } else { $DefaultDir }
$BinDir     = "$InstallDir\bin"

$UpgradeMode = $false
$ForceMode   = $false
foreach ($arg in $args) {
    if ($arg -eq "--upgrade") { $UpgradeMode = $true }
    if ($arg -eq "--force")   { $ForceMode   = $true }
}

function Info($msg)  { Write-Host "[INFO]  $msg" -ForegroundColor Green }
function Warn($msg)  { Write-Host "[WARN]  $msg" -ForegroundColor Yellow }
function Error($msg) { Write-Host "[ERROR] $msg" -ForegroundColor Red }

# ── 1. 检测 Node.js >= 24.15.0 ─────────────────────────────────────────────
function Find-Node {
    foreach ($cmd in @("node", "nodejs", "node24", "node25")) {
        $found = Get-Command $cmd -ErrorAction SilentlyContinue
        if (-not $found) { continue }
        $verOutput = & $found.Source --version 2>&1
        if ($verOutput -match "v?(\d+)\.(\d+)\.(\d+)") {
            $major = [int]$matches[1]
            $minor = [int]$matches[2]
            if ($major -gt 24) {
                return @{ Path = $found.Source; Version = "$major.$minor" }
            }
            if ($major -eq 24) {
                if ($minor -ge 15) {
                    return @{ Path = $found.Source; Version = "$major.$minor" }
                }
            }
        }
    }
    return $null
}

Info "检测 Node.js >= 24.15.0..."
$nodeInfo = Find-Node
if (-not $nodeInfo) {
    Error "未找到 Node.js 24.15.0 或更高版本"
    Write-Host ""
    Write-Host "请按以下步骤安装："
    Write-Host "  1. 访问 https://nodejs.org/"
    Write-Host "  2. 下载 Node.js LTS 版 (64-bit)"
    Write-Host "  3. 安装时勾选 'Add to PATH'"
    Write-Host ""
    exit 1
}
$node = $nodeInfo.Path
Info "Node.js: $( & $node --version )  (路径: $node)"

# ── 2. 检测 Git ────────────────────────────────────────────────────────────
Info "检测 Git..."
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Error "未找到 Git"
    Write-Host ""
    Write-Host "请下载安装 Git for Windows："
    Write-Host "  https://git-scm.com/download/win"
    Write-Host "  安装时选择 'Use Git from the command line and also from 3rd-party software'"
    Write-Host ""
    exit 1
}
Info "Git: $(git --version)"

# ── 3. 检测 / 安装 pnpm ────────────────────────────────────────────────────
Info "检测 pnpm..."
$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpm) {
    Info "pnpm 未安装，正在自动安装..."
    try {
        # 优先尝试 corepack
        & $node -e "require('child_process').execSync('corepack enable', {stdio:'inherit'})" 2>$null
        $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    } catch { }

    if (-not $pnpm) {
        try {
            $tmpPnpmInstall = "$env:TEMP\pnpm-install-$(Get-Random).ps1"
            irm https://get.pnpm.io/install.ps1 -OutFile $tmpPnpmInstall
            & $tmpPnpmInstall
            Remove-Item $tmpPnpmInstall -ErrorAction SilentlyContinue
        } catch {
            Error "pnpm 安装失败: $_"
            Write-Host "请手动安装: https://pnpm.io/installation"
            exit 1
        }
        # 安装后重新定位
        $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
        if (-not $pnpm) {
            foreach ($p in @(
                "$env:LOCALAPPDATA\pnpm\pnpm.exe",
                "$env:USERPROFILE\.local\bin\pnpm.exe",
                "$env:USERPROFILE\.cargo\bin\pnpm.exe"
            )) {
                if (Test-Path $p) {
                    $env:PATH = "$(Split-Path $p);$env:PATH"
                    $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
                    if ($pnpm) { break }
                }
            }
        }
    }
    if (-not $pnpm) {
        Error "pnpm 安装后未找到，请重新打开 PowerShell 后重试"
        exit 1
    }
}
Info "pnpm: $(pnpm --version)"

# ── 4. 确认安装路径 ────────────────────────────────────────────────────────
Info "安装路径: $InstallDir"

# ── 5. 下载 / 升级项目 ─────────────────────────────────────────────────────
$isGitRepo = $false
if (Test-Path "$InstallDir\.git") {
    $isGitRepo = $true
}

$action = "clone"
if ($UpgradeMode) {
    if ($isGitRepo) {
        if (-not $ForceMode) {
            $action = "upgrade"
        }
    }
} elseif (Test-Path $InstallDir) {
    if (-not $ForceMode) {
        if (-not $UpgradeMode) {
            $action = "exists"
        }
    }
}

if ($action -eq "upgrade") {
    Info "检测到现有安装，执行升级..."
    Set-Location $InstallDir
    try {
        git pull origin main
    } catch {
        git pull origin master
    }
} elseif ($action -eq "exists") {
    Warn "目录已存在: $InstallDir"
    Warn "如需升级现有安装，请使用: .\install.ps1 --upgrade"
    Warn "如需强制重新安装，请使用: .\install.ps1 --force"
    exit 1
} else {
    Info "下载 scream-code..."
    if (Test-Path $InstallDir) {
        Remove-Item -Recurse -Force $InstallDir
    }
    try {
        git clone --depth 1 "https://github.com/$Repo.git" $InstallDir
    } catch {
        Error "下载失败: $_"
        Write-Host "请检查网络连接（国内用户需要科学上网）"
        exit 1
    }
}

Set-Location $InstallDir

# ── 6. 安装依赖并构建 ──────────────────────────────────────────────────────
Info "安装依赖并构建..."
try {
    pnpm install
} catch {
    Error "依赖安装失败: $_"
    exit 1
}
try {
    pnpm -r build
} catch {
    Error "构建失败: $_"
    exit 1
}

# ── 7. 创建 scream 命令 ────────────────────────────────────────────────────
Info "创建 scream 命令..."
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

$NodeExe = if (Test-Path "$InstallDir\node.exe") { "$InstallDir\node.exe" } else { $node }
$ScreamCmd = @"
@echo off
set "SCREAM_HOME=$InstallDir"
cd /d "$InstallDir"
"$NodeExe" "$InstallDir\apps\scream-code\dist\main.mjs" %*
"@
Set-Content -Path "$BinDir\scream.cmd" -Value $ScreamCmd -Encoding Default

# ── 8. 添加到用户 PATH ─────────────────────────────────────────────────────
$UserPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($UserPath -notlike "*$BinDir*") {
    Info "添加 $BinDir 到用户 PATH..."
    [Environment]::SetEnvironmentVariable("PATH", "$UserPath;$BinDir", "User")
    $env:PATH = "$env:PATH;$BinDir"
}

# ── 完成 ───────────────────────────────────────────────────────────────────
Info "安装完成！"
Write-Host ""
Write-Host "安装位置: $InstallDir"
Write-Host "运行:     scream --version"
Write-Host ""
Write-Host "提示: 如果命令找不到，请重新打开 PowerShell 或 CMD"
