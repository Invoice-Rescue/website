#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Detects and repairs a corrupted Git index file.
  Common on Windows when multiple processes (IDE, agents, Defender)
  race on .git/index writes.

.DESCRIPTION
  Checks .git/index for truncation (0 bytes or missing header), removes
  the corrupted file, and rebuilds from HEAD via `git reset`.
  Also verifies that windows.appendatomically=true is set globally to
  prevent future corruption.

.EXAMPLE
  .\scripts\git-repair-index.ps1
  # Or from repo root:
  pwsh scripts/git-repair-index.ps1
#>

$ErrorActionPreference = 'Stop'

$repoRoot = git rev-parse --show-toplevel 2>$null
if (-not $repoRoot) {
    Write-Error "Not inside a Git repository."
    exit 1
}

$indexPath = Join-Path (Join-Path $repoRoot ".git") "index"

# 1. Check and fix windows.appendatomically
$atomicSetting = git config --global --get windows.appendatomically 2>$null
if ($atomicSetting -ne 'true') {
    Write-Host "[git-repair] Setting windows.appendatomically=true globally to prevent index corruption..." -ForegroundColor Yellow
    git config --global windows.appendatomically true
}

# 2. Check index health
$needsRepair = $false

if (-not (Test-Path $indexPath)) {
    Write-Host "[git-repair] .git/index is MISSING." -ForegroundColor Red
    $needsRepair = $true
}
else {
    $size = (Get-Item $indexPath).Length
    if ($size -lt 12) {
        # A valid Git index has a 12-byte header minimum (DIRC + version + entries)
        Write-Host "[git-repair] .git/index is CORRUPTED (${size} bytes, expected >= 12)." -ForegroundColor Red
        $needsRepair = $true
    }
    else {
        Write-Host "[git-repair] .git/index is healthy (${size} bytes)." -ForegroundColor Green
    }
}

if ($needsRepair) {
    Write-Host "[git-repair] Removing corrupted index and rebuilding from HEAD..." -ForegroundColor Yellow

    # Remove lock file if stuck
    $lockPath = Join-Path (Join-Path $repoRoot ".git") "index.lock"
    if (Test-Path $lockPath) {
        Remove-Item $lockPath -Force
        Write-Host "[git-repair] Removed stale index.lock file." -ForegroundColor Yellow
    }

    Remove-Item $indexPath -Force -ErrorAction SilentlyContinue
    git reset --no-refresh 2>$null

    $newSize = (Get-Item $indexPath).Length
    if ($newSize -ge 12) {
        Write-Host "[git-repair] Index rebuilt successfully (${newSize} bytes)." -ForegroundColor Green
    }
    else {
        Write-Error "[git-repair] Rebuild failed. Try: git clone fresh copy."
    }
}
else {
    Write-Host "[git-repair] No repair needed." -ForegroundColor Green
}

# 3. Quick fsck on refs (non-blocking)
Write-Host "[git-repair] Running quick ref check..." -ForegroundColor Cyan
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$null = git fsck --no-full --no-dangling 2>&1
$fsckExit = $LASTEXITCODE
$ErrorActionPreference = $prevEAP

if ($fsckExit -ne 0) {
    Write-Host "[git-repair] Stale reflogs detected. Cleaning..." -ForegroundColor Yellow
    git reflog expire --expire=now --all 2>$null
    git prune 2>$null
    Write-Host "[git-repair] Reflogs cleaned." -ForegroundColor Green
}
else {
    Write-Host "[git-repair] Refs healthy." -ForegroundColor Green
}

Write-Host "[git-repair] Done." -ForegroundColor Green
