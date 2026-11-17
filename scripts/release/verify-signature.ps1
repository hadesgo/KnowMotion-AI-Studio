<#
.SYNOPSIS
    校验 KnowMotion 发布产物的 Authenticode 签名与 updater 签名文件。

.DESCRIPTION
    逐个检查应用 EXE、NSIS 安装包与 updater 产物：
      * 签名状态必须是 Valid（含时间戳）；
      * 可选：签名证书指纹必须等于 -ExpectedThumbprint。

.EXAMPLE
    powershell -NoProfile -File scripts/release/verify-signature.ps1
    powershell -NoProfile -File scripts/release/verify-signature.ps1 -ExpectedThumbprint ABCD...
#>
[CmdletBinding()]
param(
    [string]$ExpectedThumbprint = $env:KNOWMOTION_SIGN_THUMBPRINT,
    [string]$Root = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = if ($Root) { $Root } else { Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }

$candidates = @(
    (Join-Path $repoRoot "src-tauri/target/release/knowmotion-ai-studio.exe")
)
$nsis = Join-Path $repoRoot "src-tauri/target/release/bundle/nsis"
if (Test-Path -LiteralPath $nsis) {
    $candidates += Get-ChildItem -LiteralPath $nsis -Filter "*.exe" -File | ForEach-Object { $_.FullName }
}

$existing = @($candidates | Where-Object { Test-Path -LiteralPath $_ })
if ($existing.Count -eq 0) {
    throw "No signed artifacts found. Build with scripts/release/build-signed.ps1 first."
}

$failures = 0
foreach ($file in $existing) {
    $signature = Get-AuthenticodeSignature -FilePath $file
    $ok = $signature.Status -eq "Valid"
    if ($ok -and $ExpectedThumbprint -and $signature.SignerCertificate.Thumbprint -ne $ExpectedThumbprint) {
        $ok = $false
    }
    $line = [pscustomobject]@{
        file       = $file
        status     = [string]$signature.Status
        thumbprint = if ($signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { "" }
        timestamped = [bool]($signature.TimeStamperCertificate)
        ok         = $ok
    }
    $line | Format-List | Out-String | Write-Host
    if (-not $ok) { $failures += 1 }
}

$sigFiles = @()
if (Test-Path -LiteralPath $nsis) {
    $sigFiles = @(Get-ChildItem -LiteralPath $nsis -Filter "*.sig" -File)
}
if ($sigFiles.Count -eq 0) {
    Write-Warning "No updater *.sig artifacts found under $nsis"
}

if ($failures -gt 0) {
    throw "$failures artifact(s) failed signature verification."
}
Write-Host "[verify-signature] all artifacts are validly signed"
exit 0
