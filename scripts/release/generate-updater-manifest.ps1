[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ReleaseTag,
    [string]$Repository = "",
    [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $OutputPath) {
    $OutputPath = Join-Path $repoRoot "release-evidence/artifacts/latest.json"
}
if (-not $Repository) {
    $Repository = $env:GITHUB_REPOSITORY
}
if (-not $Repository) {
    throw "Repository must be supplied or available in GITHUB_REPOSITORY"
}

$bundleRoot = Join-Path $repoRoot "src-tauri/target/release/bundle/nsis"
$installer = Get-ChildItem -LiteralPath $bundleRoot -Filter "*.exe" -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if (-not $installer) {
    throw "NSIS installer is missing"
}
$signaturePath = "$($installer.FullName).sig"
if (-not (Test-Path -LiteralPath $signaturePath)) {
    throw "Updater signature is missing: $signaturePath"
}
$version = (Get-Content -LiteralPath (Join-Path $repoRoot "src-tauri/tauri.conf.json") -Raw |
    ConvertFrom-Json).version
$assetName = [uri]::EscapeDataString($installer.Name)
$manifest = [ordered]@{
    version = $version
    notes = "KnowMotion AI Studio $ReleaseTag"
    pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    platforms = [ordered]@{
        "windows-x86_64" = [ordered]@{
            signature = (Get-Content -LiteralPath $signaturePath -Raw).Trim()
            url = "https://github.com/$Repository/releases/download/$ReleaseTag/$assetName"
        }
    }
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
$manifest | ConvertTo-Json -Depth 5 |
    Set-Content -LiteralPath $OutputPath -Encoding utf8
Write-Host "[updater] Signed manifest written to $OutputPath"
