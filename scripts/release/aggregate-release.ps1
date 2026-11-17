[CmdletBinding()]
param(
    [string]$EvidenceDirectory = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $EvidenceDirectory) {
    $EvidenceDirectory = Join-Path $repoRoot "release-evidence"
}
$artifactDirectory = Join-Path $EvidenceDirectory "artifacts"
New-Item -ItemType Directory -Force -Path $artifactDirectory | Out-Null

$candidates = @()
$releaseRoot = Join-Path $repoRoot "src-tauri/target/release"
foreach ($relative in @(
    "signed-release.json",
    "knowmotion-ai-studio.exe"
)) {
    $path = Join-Path $releaseRoot $relative
    if (Test-Path -LiteralPath $path) {
        $candidates += Get-Item -LiteralPath $path
    }
}
$bundleRoot = Join-Path $releaseRoot "bundle/nsis"
if (Test-Path -LiteralPath $bundleRoot) {
    $candidates += Get-ChildItem -LiteralPath $bundleRoot -File |
        Where-Object { $_.Extension -in @(".exe", ".sig") }
}
$sbomRoot = Join-Path $EvidenceDirectory "sbom"
if (Test-Path -LiteralPath $sbomRoot) {
    $candidates += Get-ChildItem -LiteralPath $sbomRoot -File -Filter "*.cdx.json"
}
$e2eRoot = Join-Path $repoRoot "e2e-artifacts"
if (Test-Path -LiteralPath $e2eRoot) {
    $candidates += Get-ChildItem -LiteralPath $e2eRoot -File
}
if (Test-Path -LiteralPath (Join-Path $repoRoot "src-tauri/target/release/signed-release.json")) {
    $candidates += Get-Item -LiteralPath (Join-Path $repoRoot "src-tauri/target/release/signed-release.json")
}

$copied = @()
foreach ($file in ($candidates | Sort-Object FullName -Unique)) {
    $destination = Join-Path $artifactDirectory $file.Name
    if ((Test-Path -LiteralPath $destination) -and
        ((Get-FileHash -LiteralPath $destination).Hash -ne (Get-FileHash -LiteralPath $file.FullName).Hash)) {
        $destination = Join-Path $artifactDirectory ("{0}-{1}" -f $file.Directory.Name, $file.Name)
    }
    Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
    $copied += [pscustomobject]@{
        name = $file.Name
        source = $file.FullName.Substring($repoRoot.Length).TrimStart("\", "/")
        sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash
        bytes = $file.Length
    }
}

$manifest = [pscustomobject]@{
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    sourceRevision = $env:GITHUB_SHA
    artifacts = $copied
}
$manifest | ConvertTo-Json -Depth 6 |
    Set-Content -LiteralPath (Join-Path $EvidenceDirectory "release-manifest.json") -Encoding utf8
Write-Host "[aggregate] $($copied.Count) artifacts indexed in $EvidenceDirectory"
