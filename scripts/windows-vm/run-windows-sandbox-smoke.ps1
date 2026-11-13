param(
    [string]$InstallerPath,

    [string]$OutputDirectory,

    [int]$TimeoutMinutes = 20,

    [switch]$KeepSandbox
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $PSScriptRoot "..\..\e2e-artifacts\windows-sandbox"
}

function Resolve-SandboxExecutable {
    $command = Get-Command WindowsSandbox.exe -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }
    $candidate = Join-Path $env:WINDIR "System32\WindowsSandbox.exe"
    if (Test-Path $candidate) {
        return $candidate
    }
    throw "Windows Sandbox is unavailable. Enable the Windows Sandbox optional feature or run the smoke script inside an existing clean VM."
}

function Stop-SandboxProcesses {
    Get-Process WindowsSandbox -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Get-Process WindowsSandboxClient -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

$sandboxRoot = Join-Path $env:TEMP ("knowmotion-sandbox-" + [guid]::NewGuid().ToString("N"))
$sandbox = $null
try {
    if (-not $InstallerPath) {
        $InstallerPath = Get-ChildItem "src-tauri\target\release\bundle\nsis\*.exe" |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1 -ExpandProperty FullName
    }
    if (-not $InstallerPath -or -not (Test-Path $InstallerPath)) {
        throw "NSIS installer was not found. Run npm run desktop:build first."
    }
    $InstallerPath = (Resolve-Path $InstallerPath).Path
    $OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
    New-Item -ItemType Directory -Path $sandboxRoot -Force | Out-Null
    $outputRoot = Join-Path $sandboxRoot "output"
    New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null

    Copy-Item $InstallerPath (Join-Path $sandboxRoot "KnowMotion-Setup.exe")
    Copy-Item (Join-Path $PSScriptRoot "run-install-smoke.ps1") $sandboxRoot
    Copy-Item (Join-Path $PSScriptRoot "install-smoke-composition.json") $sandboxRoot

    $entry = @'
$ErrorActionPreference = "Stop"
$root = "C:\Users\WDAGUtilityAccount\Desktop\KnowMotionVmSmoke"
try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "run-install-smoke.ps1") `
        -InstallerPath (Join-Path $root "KnowMotion-Setup.exe") `
        -CompositionPath (Join-Path $root "install-smoke-composition.json") `
        -ResultPath (Join-Path $root "output\result.json")
    $exitCode = $LASTEXITCODE
} catch {
    $_ | Out-String | Set-Content (Join-Path $root "output\entry-error.txt") -Encoding UTF8
    $exitCode = 1
}
Set-Content (Join-Path $root "output\exit-code.txt") $exitCode -Encoding ascii
'@
    Set-Content (Join-Path $sandboxRoot "sandbox-entry.ps1") $entry -Encoding UTF8

    $escapedRoot = [System.Security.SecurityElement]::Escape($sandboxRoot)
    $configPath = Join-Path $sandboxRoot "smoke.wsb"
    $config = @"
<Configuration>
  <Networking>Disable</Networking>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <PrinterRedirection>Disable</PrinterRedirection>
  <AudioInput>Disable</AudioInput>
  <VideoInput>Disable</VideoInput>
  <vGPU>Disable</vGPU>
  <MemoryInMB>8192</MemoryInMB>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>$escapedRoot</HostFolder>
      <SandboxFolder>C:\Users\WDAGUtilityAccount\Desktop\KnowMotionVmSmoke</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Users\WDAGUtilityAccount\Desktop\KnowMotionVmSmoke\sandbox-entry.ps1</Command>
  </LogonCommand>
</Configuration>
"@
    Set-Content $configPath $config -Encoding UTF8

    if (Get-Process WindowsSandbox,WindowsSandboxClient -ErrorAction SilentlyContinue) {
        throw "Close existing Windows Sandbox windows before running the automated smoke test."
    }
    $sandbox = Start-Process -FilePath (Resolve-SandboxExecutable) `
        -ArgumentList $configPath -PassThru -WindowStyle Hidden

    $exitMarker = Join-Path $outputRoot "exit-code.txt"
    $resultMarker = Join-Path $outputRoot "result.json"
    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    while ((Get-Date) -lt $deadline) {
        if ((Test-Path $exitMarker) -and (Test-Path $resultMarker)) {
            break
        }
        if ($sandbox.HasExited) {
            throw "Windows Sandbox exited before producing smoke-test evidence."
        }
        Start-Sleep -Seconds 2
    }
    if (-not (Test-Path $resultMarker)) {
        throw "Windows Sandbox smoke test timed out after $TimeoutMinutes minutes."
    }
    New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
    Copy-Item (Join-Path $outputRoot "*") $OutputDirectory -Recurse -Force
    $exitCode = [int](Get-Content $exitMarker -Raw)
    if ($exitCode -ne 0) {
        throw "Windows Sandbox smoke test failed with code $exitCode. See $OutputDirectory"
    }
    Write-Host "Windows Sandbox clean-VM smoke test passed. Evidence: $OutputDirectory"
} finally {
    if (-not $KeepSandbox) {
        Stop-SandboxProcesses
        if ($sandbox -and -not $sandbox.HasExited) {
            Stop-Process -Id $sandbox.Id -Force -ErrorAction SilentlyContinue
        }
        Remove-Item $sandboxRoot -Recurse -Force -ErrorAction SilentlyContinue
    } else {
        Write-Host "Sandbox mapping retained at $sandboxRoot"
    }
}
