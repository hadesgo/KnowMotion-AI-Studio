<#
.SYNOPSIS
    构建带 Authenticode 签名 + 签名 updater 清单的 Windows 发布包。

.DESCRIPTION
    1. 校验签名凭据与 updater 私钥是否就绪（缺一个就失败，不允许产出“半签名”发布包）。
    2. 合并 scripts/release/tauri.signing.conf.json 执行 `tauri build`：
       - `bundle.windows.signCommand` 给应用 EXE、sidecar、NSIS 安装包逐个签名；
       - `bundle.createUpdaterArtifacts` 生成带签名的 updater 产物。
    3. 逐个验签并输出 SHA-256，供 VM smoke 与发布记录使用。

    必需环境变量：
      KNOWMOTION_SIGN_PFX / KNOWMOTION_SIGN_PFX_PASSWORD   或   KNOWMOTION_SIGN_THUMBPRINT
      TAURI_SIGNING_PRIVATE_KEY（tauri signer generate 生成的私钥内容或路径）
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD（私钥有密码时）

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release/build-signed.ps1
#>
[CmdletBinding()]
param(
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$configPath = Join-Path $PSScriptRoot "tauri.signing.conf.json"

$env:KNOWMOTION_SIGN_REQUIRED = "1"
if (-not ($env:KNOWMOTION_SIGN_PFX -or $env:KNOWMOTION_SIGN_THUMBPRINT)) {
    throw "Authenticode: set KNOWMOTION_SIGN_PFX + KNOWMOTION_SIGN_PFX_PASSWORD, or KNOWMOTION_SIGN_THUMBPRINT."
}
if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
    throw "Updater: set TAURI_SIGNING_PRIVATE_KEY (generate it with: npx tauri signer generate -w <path>)."
}
if (-not (Test-Path -LiteralPath $configPath)) {
    throw "Signing config is missing: $configPath"
}

if (-not $SkipBuild) {
    Push-Location $repoRoot
    try {
        & npm run tauri -- build --config $configPath
        if ($LASTEXITCODE -ne 0) {
            throw "tauri build failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}

$targets = @()
$appExe = Join-Path $repoRoot "src-tauri/target/release/knowmotion-ai-studio.exe"
if (Test-Path -LiteralPath $appExe) { $targets += $appExe }
$bundleRoot = Join-Path $repoRoot "src-tauri/target/release/bundle/nsis"
if (Test-Path -LiteralPath $bundleRoot) {
    $targets += Get-ChildItem -LiteralPath $bundleRoot -Filter "*.exe" -File | ForEach-Object { $_.FullName }
}
if ($targets.Count -eq 0) {
    throw "No build artifacts found under src-tauri/target/release; run without -SkipBuild."
}

$results = @()
foreach ($target in $targets) {
    $signature = Get-AuthenticodeSignature -FilePath $target
    if ($signature.Status -ne "Valid") {
        throw "Artifact is not validly signed: $target ($($signature.Status))"
    }
    $results += [pscustomobject]@{
        file           = $target
        signer         = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { "" }
        thumbprint     = if ($signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { "" }
        timestamped    = [bool]($signature.TimeStamperCertificate)
        sha256         = (Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash
    }
}

$updaterSignatures = @()
if (Test-Path -LiteralPath $bundleRoot) {
    $updaterSignatures = Get-ChildItem -LiteralPath $bundleRoot -Filter "*.sig" -File | ForEach-Object { $_.FullName }
}
if ($updaterSignatures.Count -eq 0) {
    throw "No updater signature (*.sig) was produced. Check bundle.createUpdaterArtifacts and TAURI_SIGNING_PRIVATE_KEY."
}

$report = [pscustomobject]@{
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    artifacts   = $results
    updaterSignatures = $updaterSignatures
}
$reportPath = Join-Path $repoRoot "src-tauri/target/release/signed-release.json"
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $reportPath -Encoding utf8
$results | Format-Table file, signer, timestamped, sha256 -AutoSize | Out-String | Write-Host
Write-Host "[signed-release] report written to $reportPath"
