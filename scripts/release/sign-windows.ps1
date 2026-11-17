<#
.SYNOPSIS
    用 Authenticode（SHA-256 + RFC3161 时间戳）给 KnowMotion 构建产物签名。

.DESCRIPTION
    Tauri 的 `bundle.windows.signCommand` 会以 `%1` 传入每个待签名文件（应用 EXE、
    sidecar、NSIS 安装包）。本脚本只负责“签一个文件 + 立刻验签”，凭据全部来自环境变量，
    不落盘、不进仓库。

    支持两种证书来源：
      * PFX 文件：KNOWMOTION_SIGN_PFX + KNOWMOTION_SIGN_PFX_PASSWORD
      * 证书存储：KNOWMOTION_SIGN_THUMBPRINT（CI 里常用“导入证书 -> 用指纹签”）

    没有配置任何证书时：
      * KNOWMOTION_SIGN_REQUIRED=1 -> 直接失败（发布构建必须显式开启）
      * 否则打印警告并返回 0（本地开发构建保持可用）

.EXAMPLE
    $env:KNOWMOTION_SIGN_PFX = "D:\secrets\knowmotion.pfx"
    $env:KNOWMOTION_SIGN_PFX_PASSWORD = "..."
    $env:KNOWMOTION_SIGN_REQUIRED = "1"
    powershell -File scripts/release/sign-windows.ps1 <file>
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Path,
    [string]$TimestampUrl = $(if ($env:KNOWMOTION_SIGN_TIMESTAMP_URL) { $env:KNOWMOTION_SIGN_TIMESTAMP_URL } else { "http://timestamp.digicert.com" })
)

$ErrorActionPreference = "Stop"

function Resolve-SignTool {
    $command = Get-Command "signtool.exe" -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $roots = @(
        "${env:ProgramFiles(x86)}\Windows Kits\10\bin",
        "$env:ProgramFiles\Windows Kits\10\bin"
    ) | Where-Object { $_ -and (Test-Path $_) }
    foreach ($root in $roots) {
        $candidate = Get-ChildItem -Path $root -Recurse -Filter "signtool.exe" -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match "x64" } |
            Sort-Object FullName -Descending |
            Select-Object -First 1
        if ($candidate) { return $candidate.FullName }
    }
    return $null
}

function Test-Signature([string]$File) {
    $signature = Get-AuthenticodeSignature -FilePath $File
    return $signature
}

if (-not (Test-Path -LiteralPath $Path)) {
    throw "sign-windows: file not found: $Path"
}

$pfx = $env:KNOWMOTION_SIGN_PFX
$pfxPassword = $env:KNOWMOTION_SIGN_PFX_PASSWORD
$thumbprint = $env:KNOWMOTION_SIGN_THUMBPRINT
$required = $env:KNOWMOTION_SIGN_REQUIRED -eq "1"

if (-not $pfx -and -not $thumbprint) {
    if ($required) {
        throw "sign-windows: Authenticode signing is required but no certificate is configured (set KNOWMOTION_SIGN_PFX + KNOWMOTION_SIGN_PFX_PASSWORD or KNOWMOTION_SIGN_THUMBPRINT)."
    }
    Write-Warning "sign-windows: no signing certificate configured; $Path stays unsigned (set KNOWMOTION_SIGN_REQUIRED=1 to make this fatal)."
    exit 0
}

$signTool = Resolve-SignTool
if (-not $signTool) {
    throw "sign-windows: signtool.exe not found. Install the Windows SDK signing tools or add signtool to PATH."
}

$arguments = @("sign", "/fd", "SHA256", "/tr", $TimestampUrl, "/td", "SHA256")
if ($pfx) {
    if (-not (Test-Path -LiteralPath $pfx)) {
        throw "sign-windows: PFX not found: $pfx"
    }
    $arguments += @("/f", $pfx)
    if ($pfxPassword) { $arguments += @("/p", $pfxPassword) }
} else {
    $arguments += @("/sha1", $thumbprint)
}
$arguments += @($Path)

& $signTool @arguments
if ($LASTEXITCODE -ne 0) {
    throw "sign-windows: signtool failed with exit code $LASTEXITCODE for $Path"
}

$signature = Test-Signature $Path
if ($signature.Status -ne "Valid") {
    throw "sign-windows: signature is not valid for $Path ($($signature.Status))"
}
Write-Host "[sign] $([System.IO.Path]::GetFileName($Path)) -> $($signature.SignerCertificate.Subject) / $($signature.SignerCertificate.Thumbprint) / valid"
exit 0
