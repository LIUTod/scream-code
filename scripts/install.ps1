$ErrorActionPreference = "Stop"

function Find-Uv {
  # Check if uv is already on PATH
  $uv = Get-Command uv -ErrorAction SilentlyContinue
  if ($uv) {
    return $uv.Source
  }

  # Check common installation paths
  $candidates = @(
    "$env:USERPROFILE\.cargo\bin\uv.exe",
    "$env:USERPROFILE\.local\bin\uv.exe",
    "$env:LOCALAPPDATA\uv\uv.exe",
    "$env:ProgramFiles\uv\uv.exe"
  )

  foreach ($c in $candidates) {
    if (Test-Path $c) {
      return $c
    }
  }

  return $null
}

function Install-Uv {
  Write-Host "Installing uv (Python package manager)..."

  # Check PowerShell execution policy
  $policy = Get-ExecutionPolicy
  if ($policy -eq "Restricted") {
    Write-Warning "Your PowerShell execution policy is 'Restricted'."
    Write-Warning "You may need to run: Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser"
    Write-Host ""
  }

  Invoke-RestMethod -Uri "https://astral.sh/uv/install.ps1" | Invoke-Expression

  # uv installer updates PATH in the registry; refresh the current session
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not $env:Path) { $env:Path = "" }
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  if ($machinePath) { $env:Path = "$env:Path;$machinePath" }

  # Try again after installation
  $uvPath = Find-Uv
  if ($uvPath) {
    return $uvPath
  }

  Write-Error "uv was installed but could not be found. Please restart PowerShell and try again."
  exit 1
}

$uvBin = Find-Uv
if (-not $uvBin) {
  $uvBin = Install-Uv
}

Write-Host "Installing scream-code (this may take a few minutes)..."
& $uvBin tool install git+https://github.com/LIUTod/scream-code

# Check if uv tool directory is on PATH
$uvToolDir = "$env:USERPROFILE\.local\bin"
$pathDirs = $env:Path -split ";"
$toolDirOnPath = $false
foreach ($dir in $pathDirs) {
  if ($dir.Trim() -eq $uvToolDir) {
    $toolDirOnPath = $true
    break
  }
}

if (-not $toolDirOnPath) {
  Write-Host ""
  Write-Host "========================================"
  Write-Host "Installation complete!"
  Write-Host ""
  Write-Host "One more step: add the following directory"
  Write-Host "to your PATH so 'scream' is available in new terminals:"
  Write-Host ""
  Write-Host "  $uvToolDir"
  Write-Host ""
  Write-Host "You can add it via System Settings, or run:"
  Write-Host "  [Environment]::SetEnvironmentVariable('Path', \"$env:Path;$uvToolDir\", 'User')"
  Write-Host ""
  Write-Host "Or run it directly now:"
  Write-Host "  $uvToolDir\scream.exe"
  Write-Host "========================================"
} else {
  Write-Host ""
  Write-Host "Installation complete! Run 'scream' to start."
}
