# Deploys the dsh-acps plugin and the acps / acps-headless profiles into
# $DSH_HOME (default: ~/.dsh). The plugin package is COPIED into each
# profile's node_modules (not symlinked) so its bare @deepseek-ai/* imports
# resolve through the shared $DSH_HOME/profiles/node_modules fallback.
#
# Usage: powershell -File scripts/deploy-profile.ps1 [-DshHome C:\path\.dsh]

param(
    [string]$DshHome = ""
)

$ErrorActionPreference = "Stop"
if ($DshHome -eq "") { $DshHome = Join-Path $env:USERPROFILE ".dsh" }

$repo = Split-Path $PSScriptRoot -Parent
$pkgSrc = Join-Path $repo "packages\dsh-acps"

foreach ($profile in @("acps", "acps-headless")) {
    $profileDir = Join-Path $DshHome "profiles\$profile"
    $modulesDir = Join-Path $profileDir "node_modules"
    New-Item -ItemType Directory -Force -Path $modulesDir | Out-Null

    # Fresh copy of the plugin package (removes stale files first)
    $dest = Join-Path $modulesDir "dsh-acps"
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    Copy-Item -Recurse -Force $pkgSrc $dest

    # Profile manifest + patch + pnpm workspace
    foreach ($f in @("package.json", "cordis.patch.yml", "pnpm-workspace.yaml")) {
        Copy-Item -Force (Join-Path $repo "profiles\$profile\$f") (Join-Path $profileDir $f)
    }
    Write-Host "deployed profile '$profile' -> $profileDir"
}

Write-Host "deploy complete (DSH_HOME=$DshHome)"
