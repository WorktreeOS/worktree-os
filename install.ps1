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
# Finish installation by configuring %USERPROFILE%\.wos\config.json. Under
# `irm ... | iex` the binary's own wizard may not get an interactive stdin and
# would silently apply defaults. Instead we run the survey HERE via Read-Host
# and delegate the answers to a non-interactive `wos init --yes` with flags,
# which writes the config without starting the daemon. Call the binary by full
# path since $InstallDir may not be active in this shell yet.

# Prompt for a value, returning $default when the answer is blank.
function Read-WithDefault($prompt, $default) {
    $answer = Read-Host "$prompt [$default]"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
    return $answer
}

# Yes/no prompt; returns the bool, defaulting to $defaultYes on a blank answer.
function Confirm-Yn($prompt, $defaultYes) {
    $hint = if ($defaultYes) { 'Y/n' } else { 'y/N' }
    $answer = (Read-Host "$prompt ($hint)").Trim().ToLower()
    if ([string]::IsNullOrWhiteSpace($answer)) { return $defaultYes }
    return ($answer -eq 'y' -or $answer -eq 'yes')
}

Write-Step "Starting wos setup ('wos init')..."
$initArgs = @('init', '--yes')
# $host is an automatic PowerShell variable — use $bindHost for the bind address.
$interactive = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected
if ($interactive) {
    $bindHost = Read-WithDefault 'Daemon bind address' '127.0.0.1'
    $initArgs += @('--host', $bindHost)

    $webPort = Read-WithDefault 'Web UI port' '4949'
    $initArgs += @('--port', $webPort)

    # Let the binary pick the backend after detect/install; only opt into the
    # psmux install when it is missing and the user agrees.
    if (Get-Command psmux -ErrorAction SilentlyContinue) {
        Write-Step 'psmux detected - the tmux terminal backend will be used.'
    } elseif (Confirm-Yn 'Install psmux for stable terminal sessions?' $true) {
        $initArgs += '--install-tmux'
    }

    $hasClaude = [bool](Get-Command claude -ErrorAction SilentlyContinue)
    $hasOpencode = [bool](Get-Command opencode -ErrorAction SilentlyContinue)
    if ($hasClaude -or $hasOpencode) {
        if (Confirm-Yn 'Install wos agent plugins for detected agents (claude/opencode)?' $true) {
            $initArgs += '--install-plugins'
        }
    }
} else {
    Write-Warn "No interactive terminal; applying defaults. Re-run 'wos init' to customize."
}

& $dest @initArgs
if ($LASTEXITCODE -ne 0) {
    Write-Warn "setup did not finish (Docker may be missing); run 'wos init' to complete it."
}

# --- next steps -------------------------------------------------------------
# $InstallDir was already added to the user PATH above, so just point at start.

Write-Host ''
Write-Step 'Setup complete. Next steps:'
Write-Host '    Start the daemon:  wos start'
