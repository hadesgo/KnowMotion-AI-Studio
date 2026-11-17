[CmdletBinding()]
param(
    [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $repoRoot "release-evidence/sbom"
}
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

Push-Location $repoRoot
try {
    $existingRustSboms = @(Get-ChildItem -Path "src-tauri" -Filter "*.cdx.json" -File -ErrorAction SilentlyContinue)
    foreach ($sbom in $existingRustSboms) {
        Remove-Item -LiteralPath $sbom.FullName -Force
    }
    & cargo cyclonedx --manifest-path src-tauri/Cargo.toml --format json
    if ($LASTEXITCODE -ne 0) {
        throw "cargo-cyclonedx failed with exit code $LASTEXITCODE"
    }
    $rustSbom = Get-ChildItem -Path "src-tauri" -Filter "*.cdx.json" -File |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if (-not $rustSbom) {
        throw "cargo-cyclonedx did not produce a JSON SBOM"
    }
    Copy-Item -LiteralPath $rustSbom.FullName `
        -Destination (Join-Path $OutputDirectory "rust.cdx.json") -Force

    & npm sbom --sbom-format=cyclonedx |
        Set-Content -LiteralPath (Join-Path $OutputDirectory "npm.cdx.json") -Encoding utf8
    if ($LASTEXITCODE -ne 0) {
        throw "npm sbom failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

foreach ($name in @("rust.cdx.json", "npm.cdx.json")) {
    $path = Join-Path $OutputDirectory $name
    $document = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    if ($document.bomFormat -ne "CycloneDX") {
        throw "$name is not a CycloneDX document"
    }
}

Write-Host "[sbom] CycloneDX documents written to $OutputDirectory"
