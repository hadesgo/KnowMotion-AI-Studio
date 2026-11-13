param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,

    [Parameter(Mandatory = $true)]
    [string]$ResultPath,

    [string]$CompositionPath,

    [switch]$SkipUninstall,

    [switch]$AllowExistingInstall,

    [switch]$SkipInstall,

    [switch]$RequireSignature,

    [string]$ExpectedSignerThumbprint,

    [switch]$EnforceOffline
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
if (-not $CompositionPath) {
    $CompositionPath = Join-Path $PSScriptRoot "install-smoke-composition.json"
}
$startedAt = Get-Date
$exitCode = 0
$evidence = [ordered]@{}
$appProcess = $null
$firewallRules = @()

function Write-Stage {
    param([string]$Name, [string]$Status, [hashtable]$Data = @{})
    $record = [ordered]@{
        name = $Name
        status = $Status
        at = (Get-Date).ToUniversalTime().ToString("o")
    }
    foreach ($key in $Data.Keys) {
        $record[$key] = $Data[$key]
    }
    if (-not $evidence.Contains("stages")) {
        $evidence["stages"] = @()
    }
    $evidence["stages"] += $record
    Write-Host "[$Status] $Name"
}

function Find-AppInstall {
    $candidates = @()
    $roots = @(
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
        "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
    )
    foreach ($root in $roots) {
        if (-not (Test-Path $root)) {
            continue
        }
        foreach ($key in Get-ChildItem $root -ErrorAction SilentlyContinue) {
            $item = Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue
            if ($item.DisplayName -like "KnowMotion AI Studio*") {
                if ($item.InstallLocation) {
                    $candidates += [string]$item.InstallLocation
                }
                if ($item.UninstallString) {
                    $uninstall = [string]$item.UninstallString
                    if ($uninstall -match '^"([^"]+)"') {
                        $candidates += Split-Path -Parent $matches[1]
                    }
                }
            }
        }
    }
    $candidates += @(
        (Join-Path $env:LOCALAPPDATA "Programs\KnowMotion AI Studio"),
        (Join-Path $env:LOCALAPPDATA "KnowMotion AI Studio"),
        (Join-Path $env:ProgramFiles "KnowMotion AI Studio")
    )
    foreach ($candidate in $candidates | Select-Object -Unique) {
        $candidate = ([string]$candidate).Trim().Trim('"')
        if (Test-Path (Join-Path $candidate "knowmotion-ai-studio.exe")) {
            return (Resolve-Path $candidate).Path
        }
    }
    return $null
}

function Invoke-Installer {
    param([string]$Path)
    if (-not (Test-Path $Path)) {
        throw "Installer not found: $Path"
    }
    $process = Start-Process -FilePath $Path -ArgumentList "/S" -Wait -PassThru -WindowStyle Hidden
    if ($process.ExitCode -ne 0) {
        throw "Installer exited with code $($process.ExitCode)"
    }
}

function Wait-ForInstall {
    $deadline = (Get-Date).AddSeconds(45)
    do {
        $location = Find-AppInstall
        if ($location) {
            return $location
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw "Application installation could not be located after 45 seconds."
}

function Assert-File {
    param([string]$Path)
    if (-not (Test-Path $Path -PathType Leaf)) {
        throw "Required installed file is missing: $Path"
    }
    $file = Get-Item $Path
    if ($file.Length -le 0) {
        throw "Required installed file is empty: $Path"
    }
    return $file.Length
}

function Enable-OfflineExecution {
    param([string]$InstallDir)
    if (-not $EnforceOffline) {
        return
    }
    $principals = @(
        (Join-Path $InstallDir "knowmotion-ai-studio.exe"),
        (Join-Path $InstallDir "node.exe"),
        (Find-ResourceFile $InstallDir "browser/chrome-headless-shell.exe"),
        (Find-ResourceFile $InstallDir "ffmpeg/ffmpeg.exe"),
        (Find-ResourceFile $InstallDir "ffmpeg/ffprobe.exe")
    )
    foreach ($principal in $principals) {
        $name = "KnowMotion-CleanVmSmoke-Block-" + [guid]::NewGuid().ToString("N")
        try {
            New-NetFirewallRule -DisplayName $name `
                -Direction Outbound -Program $principal -Action Block -Profile Any | Out-Null
        } catch {
            throw "EnforceOffline requires an elevated administrator shell: $($_.Exception.Message)"
        }
        $script:firewallRules += $name
    }
}

function Find-ResourceFile {
    param([string]$InstallDir, [string]$Relative)
    $candidates = @(
        (Join-Path (Join-Path $InstallDir "resources") $Relative),
        (Join-Path $InstallDir $Relative),
        (Join-Path (Join-Path $InstallDir "resources") (Join-Path "resources" $Relative))
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate -PathType Leaf) {
            return (Resolve-Path $candidate).Path
        }
    }
    throw "Bundled resource is missing: $Relative"
}

function Verify-RuntimeManifest {
    param([string]$InstallDir)
    $manifestPath = Find-ResourceFile $InstallDir "runtime-manifest.json"
    $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
    $verified = 0
    foreach ($entry in $manifest.files) {
        $relative = [string]$entry.path
        if ($relative -match '^binaries/node-.*\.exe$') {
            $path = Join-Path $InstallDir "node.exe"
        } else {
            $resourceRelative = $relative -replace '^resources/', ''
            $path = Find-ResourceFile $InstallDir $resourceRelative
        }
        $actual = (Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne ([string]$entry.sha256).ToLowerInvariant()) {
            throw "Runtime hash mismatch: $relative"
        }
        $verified++
    }
    return @{
        manifest = $manifestPath
        rendererVersion = [string]$manifest.rendererVersion
        nodeVersion = [string]$manifest.nodeVersion
        verifiedFiles = $verified
    }
}

function Invoke-OfflineRender {
    param([string]$InstallDir)
    $node = Join-Path $InstallDir "node.exe"
    $rendererRoot = Split-Path -Parent (Find-ResourceFile $InstallDir "renderer/scripts/render-worker.ts")
    $rendererRoot = Split-Path -Parent $rendererRoot
    $worker = Find-ResourceFile $InstallDir "renderer/scripts/render-worker.ts"
    $tsx = Find-ResourceFile $InstallDir "renderer/node_modules/tsx/dist/cli.mjs"
    $entry = Find-ResourceFile $InstallDir "renderer/src/remotion/index.ts"
    $browser = Find-ResourceFile $InstallDir "browser/chrome-headless-shell.exe"
    $ffmpeg = Find-ResourceFile $InstallDir "ffmpeg/ffmpeg.exe"
    $ffprobe = Find-ResourceFile $InstallDir "ffmpeg/ffprobe.exe"
    Assert-File $node | Out-Null

    $temp = Join-Path $env:TEMP ("knowmotion-install-render-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $temp -Force | Out-Null
    $output = Join-Path $temp "offline-smoke.mp4"
    $manifestPath = Join-Path $temp "render-job.json"
    $composition = Get-Content $CompositionPath -Raw | ConvertFrom-Json
    $manifest = [ordered]@{
        schemaVersion = "1.0"
        jobId = "windows-install-smoke"
        entryPoint = $entry
        compositionId = "KnowledgeVideo"
        inputProps = @{ composition = $composition }
        output = @{
            path = $output
            codec = "h264"
            videoBitrate = "2M"
        }
        runtime = @{
            browserExecutable = $browser
            ffmpegExecutable = $ffmpeg
            chromeMode = "headless-shell"
            concurrency = 1
            timeoutMs = 120000
        }
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText(
        $manifestPath,
        ($manifest | ConvertTo-Json -Depth 40),
        $utf8NoBom
    )

    $stdoutPath = Join-Path $temp "worker.stdout.log"
    $stderrPath = Join-Path $temp "worker.stderr.log"
    $process = Start-Process -FilePath $node `
        -ArgumentList @("`"$tsx`"", "`"$worker`"", "`"$manifestPath`"") `
        -WorkingDirectory $rendererRoot `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -PassThru -WindowStyle Hidden
    if (-not $process.WaitForExit(180000)) {
        $process.Kill()
        throw "Offline renderer timed out."
    }
    $process.WaitForExit()
    $process.Refresh()
    $workerExitCode = $process.ExitCode
    $workerStdout = if (Test-Path $stdoutPath) { Get-Content $stdoutPath -Raw } else { "" }
    if ($null -eq $workerExitCode -and $workerStdout -match '"type":"completed"') {
        $workerExitCode = 0
    }
    if ($workerExitCode -ne 0) {
        $stderr = if (Test-Path $stderrPath) { Get-Content $stderrPath -Raw } else { "" }
        throw "Offline renderer failed with code ${workerExitCode}:`nSTDOUT:`n$workerStdout`nSTDERR:`n$stderr"
    }
    $bytes = Assert-File $output
    $probeJson = & $ffprobe -v error -show_entries format=duration:stream=codec_type,codec_name -of json $output
    if ($LASTEXITCODE -ne 0) {
        throw "FFprobe could not parse the rendered MP4."
    }
    $probe = $probeJson | ConvertFrom-Json
    if (-not ($probe.streams | Where-Object { $_.codec_type -eq "video" })) {
        throw "Offline render has no video stream."
    }
    $duration = [double]$probe.format.duration
    if ($duration -lt 1.2 -or $duration -gt 1.8) {
        throw "Unexpected rendered duration: $duration"
    }
    $sha256 = (Get-FileHash $output -Algorithm SHA256).Hash
    return @{
        bytes = $bytes
        durationSeconds = $duration
        sha256 = $sha256
        output = $output
        stdoutTail = (Get-Content $stdoutPath -Tail 5) -join "`n"
    }
}

function Invoke-AppStartup {
    param([string]$InstallDir)
    $exe = Join-Path $InstallDir "knowmotion-ai-studio.exe"
    $appData = Join-Path $env:APPDATA "com.knowmotion.studio"
    $logPath = Join-Path $appData "logs\knowmotion.log"
    if (Test-Path $logPath) {
        Remove-Item $logPath -Force
    }
    $script:appProcess = Start-Process -FilePath $exe -WorkingDirectory $InstallDir -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 8
    $script:appProcess.Refresh()
    if ($script:appProcess.HasExited) {
        throw "Installed application exited during startup with code $($script:appProcess.ExitCode)."
    }
    $deadline = (Get-Date).AddSeconds(15)
    while (-not (Test-Path $logPath) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 250
    }
    if (-not (Test-Path $logPath)) {
        throw "Application started but did not create its production log."
    }
    $log = Get-Content $logPath -Raw
    if ($log -notmatch "Desktop services initialized") {
        throw "Application log does not contain the initialized marker."
    }
    return @{
        processId = $script:appProcess.Id
        logPath = $logPath
        logBytes = (Get-Item $logPath).Length
    }
}

function Invoke-Uninstall {
    param([string]$InstallDir)
    $uninstaller = Join-Path $InstallDir "Uninstall.exe"
    if (-not (Test-Path $uninstaller)) {
        $uninstaller = Join-Path $InstallDir "uninstall.exe"
    }
    if (-not (Test-Path $uninstaller)) {
        throw "Uninstaller was not found."
    }
    $process = Start-Process -FilePath $uninstaller `
        -ArgumentList @("/S", "`"_?=$InstallDir`"") `
        -PassThru -Wait -WindowStyle Hidden
    if ($process.ExitCode -ne 0) {
        throw "Uninstaller exited with code $($process.ExitCode)"
    }
    $deadline = (Get-Date).AddSeconds(30)
    $criticalFiles = @(
        (Join-Path $InstallDir "knowmotion-ai-studio.exe"),
        (Join-Path $InstallDir "node.exe"),
        (Join-Path $InstallDir "resources\browser\chrome-headless-shell.exe"),
        (Join-Path $InstallDir "resources\ffmpeg\ffmpeg.exe"),
        (Join-Path $InstallDir "resources\renderer\scripts\render-worker.ts")
    )
    while ((@($criticalFiles | Where-Object { Test-Path $_ }).Count -gt 0) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
    }
    $remaining = @($criticalFiles | Where-Object { Test-Path $_ })
    if ($remaining.Count -gt 0) {
        throw "Installed runtime files remain after silent uninstall: $($remaining -join ', ')"
    }
}

try {
    $installerResolved = (Resolve-Path $InstallerPath).Path
    $signature = Get-AuthenticodeSignature $installerResolved
    Write-Stage "preflight" "started" @{
        os = [System.Environment]::OSVersion.VersionString
        architecture = $env:PROCESSOR_ARCHITECTURE
        user = $env:USERNAME
        installer = $installerResolved
        signatureStatus = [string]$signature.Status
        signerThumbprint = if ($signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { "" }
    }
    if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
        throw "This smoke test requires Windows."
    }
    if (-not (Test-Path $CompositionPath)) {
        throw "Smoke composition is missing: $CompositionPath"
    }
    if ($RequireSignature -and $signature.Status -ne "Valid") {
        throw "Installer signature is not valid: $($signature.Status)"
    }
    if ($ExpectedSignerThumbprint -and $signature.SignerCertificate.Thumbprint -ne $ExpectedSignerThumbprint) {
        throw "Installer signer thumbprint does not match the expected certificate."
    }
    $existing = Find-AppInstall
    if ($existing -and -not $AllowExistingInstall) {
        if (-not $SkipInstall) {
            throw "A KnowMotion installation already exists at $existing. Clean VM required."
        }
    }

    if ($SkipInstall) {
        if (-not $existing) {
            throw "SkipInstall requires an existing KnowMotion installation."
        }
        $installDir = $existing
        Write-Stage "install" "reused" @{ installDir = $installDir }
    } else {
        Invoke-Installer $InstallerPath
        $installDir = Wait-ForInstall
        Write-Stage "install" "passed" @{ installDir = $installDir }
    }

    $required = @(
        "knowmotion-ai-studio.exe",
        "node.exe"
    )
    foreach ($relative in $required) {
        Assert-File (Join-Path $installDir $relative) | Out-Null
    }
    $runtime = Verify-RuntimeManifest $installDir
    Write-Stage "runtime-manifest" "passed" $runtime
    Enable-OfflineExecution $installDir
    if ($EnforceOffline) {
        Write-Stage "offline-network-policy" "passed" @{ blockedPrograms = $firewallRules.Count }
    }

    $render = Invoke-OfflineRender $installDir
    Write-Stage "offline-render" "passed" $render

    $startup = Invoke-AppStartup $installDir
    Write-Stage "app-startup" "passed" $startup

    if ($appProcess -and -not $appProcess.HasExited) {
        Stop-Process -Id $appProcess.Id -Force
        $appProcess.WaitForExit(5000) | Out-Null
    }

    if (-not $SkipUninstall) {
        Invoke-Uninstall $installDir
        Write-Stage "uninstall" "passed" @{}
    }

    $evidence["result"] = "passed"
} catch {
    $evidence["result"] = "failed"
    $evidence["error"] = $_.Exception.Message
    if ($_.ScriptStackTrace) {
        $evidence["stack"] = $_.ScriptStackTrace
    }
    Write-Stage "failure" "failed" @{ error = $_.Exception.Message }
    $exitCode = 1
} finally {
    if ($appProcess -and -not $appProcess.HasExited) {
        Stop-Process -Id $appProcess.Id -Force -ErrorAction SilentlyContinue
    }
    foreach ($rule in $firewallRules) {
        Remove-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue
    }
    $evidence["startedAt"] = $startedAt.ToUniversalTime().ToString("o")
    $evidence["finishedAt"] = (Get-Date).ToUniversalTime().ToString("o")
    $evidence["durationSeconds"] = [math]::Round(((Get-Date) - $startedAt).TotalSeconds, 2)
    $resultDirectory = Split-Path -Parent $ResultPath
    if ($resultDirectory) {
        New-Item -ItemType Directory -Path $resultDirectory -Force | Out-Null
    }
    $evidence | ConvertTo-Json -Depth 20 | Set-Content $ResultPath -Encoding UTF8
    if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot "..\..\e2e-artifacts"))) {
        Copy-Item $ResultPath (Join-Path $PSScriptRoot "..\..\e2e-artifacts\windows-install-last.json") -Force -ErrorAction SilentlyContinue
    }
    if ($exitCode -ne 0) {
        exit $exitCode
    }
}
