<#
.SYNOPSIS
    WorktreeOS (`wos`) installer for Windows (PowerShell).

.DESCRIPTION
    Downloads the prebuilt wos.exe from GitHub Releases and installs it into a
    per-user directory (no admin required), adding that directory to the user
    PATH if needed.

.EXAMPLE
    irm https://raw.githubusercontent.com/WorktreeOS/worktree-os/main/install.ps1 | iex

.PARAMETER Version
    Release tag to install (e.g. v0.1.0). Defaults to the latest release.
    Override via -Version or the WOS_VERSION environment variable.

.PARAMETER InstallDir
    Install directory. Defaults to $env:LOCALAPPDATA\Programs\wos.
    Override via -InstallDir or the WOS_INSTALL_DIR environment variable.
#>
[CmdletBinding()]
param(
    [string]$Version,
    [string]$InstallDir
)

$ErrorActionPreference = 'Stop'
# Force TLS 1.2 for older Windows PowerShell (5.1) where it is not the default.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo = 'WorktreeOS/worktree-os'
$Bin  = 'wos.exe'
$Api  = "https://api.github.com/repos/$Repo"

function Coalesce { foreach ($v in $args) { if (-not [string]::IsNullOrWhiteSpace($v)) { return $v } } return $null }

$Version    = Coalesce $Version    $env:WOS_VERSION 'latest'
$InstallDir = Coalesce $InstallDir $env:WOS_INSTALL_DIR (Join-Path $env:LOCALAPPDATA 'Programs\wos')

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Warn($msg) { Write-Host "warning: $msg" -ForegroundColor Yellow }

$headers = @{ 'User-Agent' = 'wos-installer' }

# --- detect arch ------------------------------------------------------------

$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -ne 'AMD64') {
    throw "Unsupported architecture '$arch'. Prebuilt binaries are Windows amd64 only; build from source with 'bun run build:binary'."
}

# --- resolve version --------------------------------------------------------

if ($Version -eq 'latest') {
    Write-Step 'Resolving latest release...'
    try {
        $Version = (Invoke-RestMethod -Uri "$Api/releases/latest" -Headers $headers).tag_name
    } catch {
        throw "Could not resolve the latest release tag. Set -Version vX.Y.Z and retry. ($_)"
    }
}
if ([string]::IsNullOrWhiteSpace($Version)) { throw 'Could not resolve a release version.' }

$asset = "wos-$Version-windows-amd64.exe"
$url   = "https://github.com/$Repo/releases/download/$Version/$asset"

# --- download & install -----------------------------------------------------

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$dest = Join-Path $InstallDir $Bin
$tmp  = "$dest.download"

# Always (re)download and overwrite — when a build already exists this updates
# it, so re-running the installer doubles as an updater. There is no
# "already installed, skip" shortcut on purpose.
$existing = (Test-Path $dest) -or [bool](Get-Command wos -ErrorAction SilentlyContinue)
$action = if ($existing) { 'Updating' } else { 'Installing' }
Write-Step "$action wos to $Version (windows-amd64)"
Write-Step "Downloading $url"

try {
    Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing -Headers $headers
} catch {
    throw "Download failed. Check that release '$Version' has asset '$asset'. ($_)"
}
if ((Get-Item $tmp).Length -le 0) { Remove-Item $tmp -Force; throw 'Downloaded file is empty.' }

Move-Item -Path $tmp -Destination $dest -Force
Write-Step "Installed to $dest"

# --- PATH update ------------------------------------------------------------

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$onPath = ($userPath -split ';') -contains $InstallDir
if (-not $onPath) {
    Write-Step "Adding $InstallDir to your user PATH"
    $newPath = if ([string]::IsNullOrEmpty($userPath)) { $InstallDir } else { "$userPath;$InstallDir" }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    # Make it usable in the current session too.
    $env:Path = "$env:Path;$InstallDir"
    Write-Warn 'PATH updated. Restart open terminals (or sign out/in) for it to take effect everywhere.'
}

# --- run setup --------------------------------------------------------------
# Hand off to the wos setup wizard (`wos init`) to finish installation. Call it
# by full path since $InstallDir may not be active in this shell yet. A non-zero
# exit (e.g. Docker missing) only warns — the binary is already installed.
Write-Step "Starting wos setup ('wos init')..."
& $dest init
if ($LASTEXITCODE -ne 0) {
    Write-Warn "setup did not finish (exit $LASTEXITCODE); run 'wos init' to complete it."
}
