[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet("Start", "Stop", "Restart", "Status")]
    [string]$Action = "Status",

    [Parameter(Position = 1)]
    [ValidateSet("All", "Control", "Session", "Bridge")]
    [string]$Service = "All",

    [ValidateRange(1, 65535)]
    [int]$BridgePort = 8877,

    [ValidateRange(1, 65535)]
    [int]$ControlPort = 8878,

    [ValidateRange(1, 65535)]
    [int]$SessionPort = 8879,

    [string]$Python = "python",

    [string]$ConfigPath
)

$ErrorActionPreference = "Stop"
$ProjectDir = $PSScriptRoot
$DataDir = Join-Path $ProjectDir "data"
New-Item -ItemType Directory -Path $DataDir -Force | Out-Null

function Get-ServiceInfo {
    param([ValidateSet("Control", "Session", "Bridge")][string]$Name)

    $slug = $Name.ToLowerInvariant()
    [pscustomobject]@{
        Name = $Name
        PidPath = Join-Path $DataDir "$slug.pid.json"
        StdoutPath = Join-Path $DataDir "$slug.stdout.log"
        StderrPath = Join-Path $DataDir "$slug.stderr.log"
    }
}

function Read-PidRecord {
    param($Info)

    if (-not (Test-Path -LiteralPath $Info.PidPath -PathType Leaf)) {
        return $null
    }
    try {
        return Get-Content -LiteralPath $Info.PidPath -Raw | ConvertFrom-Json
    }
    catch {
        Write-Warning "$($Info.Name) PID file is invalid: $($Info.PidPath)"
        return $null
    }
}

function Get-ManagedProcess {
    param($Info)

    $record = Read-PidRecord $Info
    if ($null -eq $record) {
        return $null
    }
    $process = Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        Remove-Item -LiteralPath $Info.PidPath -Force -ErrorAction SilentlyContinue
        return $null
    }
    try {
        $actualTicks = $process.StartTime.ToUniversalTime().Ticks
        if ([int64]$record.start_time_utc_ticks -ne $actualTicks) {
            Write-Warning "$($Info.Name) PID was reused; leaving process $($process.Id) untouched."
            Remove-Item -LiteralPath $Info.PidPath -Force -ErrorAction SilentlyContinue
            return $null
        }
        if (-not $record.script_path) {
            Write-Warning "$($Info.Name) PID record has no script identity; leaving process $($process.Id) untouched."
            return $null
        }
        $commandLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)").CommandLine
        if (-not $commandLine -or $commandLine.IndexOf([string]$record.script_path, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
            Write-Warning "$($Info.Name) command line does not match its PID record; leaving process $($process.Id) untouched."
            return $null
        }
    }
    catch {
        Write-Warning "Cannot validate $($Info.Name) process $($process.Id); leaving it untouched."
        return $null
    }
    return $process
}

function Resolve-Python {
    $command = Get-Command $Python -ErrorAction Stop
    return $command.Source
}

function Normalize-ProcessPathEnvironment {
    # Some Windows hosts expose both Path and PATH. Start-Process treats them as
    # duplicate dictionary keys, so collapse them in this launcher process.
    $currentPath = $env:Path
    [Environment]::SetEnvironmentVariable("PATH", $null, [EnvironmentVariableTarget]::Process)
    [Environment]::SetEnvironmentVariable("Path", $currentPath, [EnvironmentVariableTarget]::Process)
}

function Start-ManagedService {
    param([ValidateSet("Control", "Session", "Bridge")][string]$Name)

    $info = Get-ServiceInfo $Name
    $existing = Get-ManagedProcess $info
    if ($null -ne $existing) {
        Write-Host "$Name is already running (PID $($existing.Id))."
        return
    }

    $pythonExe = Resolve-Python
    if ($Name -eq "Control") {
        $scriptPath = Join-Path $ProjectDir "control_plane.py"
        $arguments = @("`"$scriptPath`"", "--port", "$ControlPort", "--data-dir", "`"$DataDir`"")
    }
    elseif ($Name -eq "Session") {
        $scriptPath = Join-Path $ProjectDir "sessiond.py"
        $keyPath = Join-Path $DataDir "control_signing.key"
        if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) {
            throw "Control signing key is missing. Start the Control service first."
        }
        $arguments = @(
            "`"$scriptPath`"", "--port", "$SessionPort", "--data-dir", "`"$DataDir`"",
            "--control-url", "http://127.0.0.1:$ControlPort",
            "--control-key-file", "`"$keyPath`""
        )
        if ($ConfigPath) {
            $resolvedConfig = (Resolve-Path -LiteralPath $ConfigPath).Path
            $arguments += @("--config", "`"$resolvedConfig`"")
        }
    }
    else {
        $scriptPath = Join-Path $ProjectDir "bridge.py"
        $keyPath = Join-Path $DataDir "sessiond.key"
        if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) {
            throw "Session daemon key is missing. Start the Session service first."
        }
        $arguments = @(
            "`"$scriptPath`"", "--port", "$BridgePort",
            "--session-url", "http://127.0.0.1:$SessionPort",
            "--session-key-file", "`"$keyPath`""
        )
        if ($ConfigPath) {
            $resolvedConfig = (Resolve-Path -LiteralPath $ConfigPath).Path
            $arguments += @("--config", "`"$resolvedConfig`"")
        }
    }

    Normalize-ProcessPathEnvironment
    $process = Start-Process -FilePath $pythonExe -ArgumentList $arguments `
        -WorkingDirectory $ProjectDir -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $info.StdoutPath -RedirectStandardError $info.StderrPath
    Start-Sleep -Milliseconds 500
    $process.Refresh()
    if ($process.HasExited) {
        $details = Get-Content -LiteralPath $info.StderrPath -Raw -ErrorAction SilentlyContinue
        throw "$Name failed to start. $details"
    }

    [pscustomobject]@{
        service = $Name
        pid = $process.Id
        script_path = $scriptPath
        start_time_utc_ticks = $process.StartTime.ToUniversalTime().Ticks
        started_at = (Get-Date).ToUniversalTime().ToString("o")
    } | ConvertTo-Json | Set-Content -LiteralPath $info.PidPath -Encoding ASCII
    Write-Host "$Name started (PID $($process.Id)). Logs: $($info.StdoutPath), $($info.StderrPath)"
}

function Stop-ManagedService {
    param([ValidateSet("Control", "Session", "Bridge")][string]$Name)

    $info = Get-ServiceInfo $Name
    $process = Get-ManagedProcess $info
    if ($null -eq $process) {
        Write-Host "$Name is not running."
        return
    }
    Stop-Process -Id $process.Id
    try {
        Wait-Process -Id $process.Id -Timeout 10 -ErrorAction Stop
    }
    catch {
        throw "$Name did not stop within 10 seconds; process $($process.Id) was not force-killed."
    }
    Remove-Item -LiteralPath $info.PidPath -Force -ErrorAction SilentlyContinue
    Write-Host "$Name stopped."
}

function Show-ServiceStatus {
    param([ValidateSet("Control", "Session", "Bridge")][string]$Name)

    $info = Get-ServiceInfo $Name
    $process = Get-ManagedProcess $info
    if ($null -eq $process) {
        Write-Host "$Name`: stopped"
    }
    else {
        Write-Host "$Name`: running (PID $($process.Id), since $($process.StartTime))"
    }
}

$services = if ($Service -eq "All") { @("Control", "Session", "Bridge") } else { @($Service) }

function Stop-Order {
    param([string]$Name)
    if ($Name -eq "Bridge") { return 0 }
    if ($Name -eq "Session") { return 1 }
    return 2
}

switch ($Action) {
    "Start" {
        foreach ($name in $services) { Start-ManagedService $name }
    }
    "Stop" {
        # Stop the command service first so control-plane grants remain available until it exits.
        foreach ($name in @($services | Sort-Object { Stop-Order $_ })) {
            Stop-ManagedService $name
        }
    }
    "Restart" {
        foreach ($name in @($services | Sort-Object { Stop-Order $_ })) {
            Stop-ManagedService $name
        }
        foreach ($name in $services) { Start-ManagedService $name }
    }
    "Status" {
        foreach ($name in $services) { Show-ServiceStatus $name }
    }
}
