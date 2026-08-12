[CmdletBinding()]
param(
    [Parameter(Position = 0)][ValidateSet("Start", "Stop", "Restart", "Status")][string]$Action = "Status",
    [Parameter(Position = 1)][ValidateSet("All", "Control", "Session", "Bridge")][string]$Service = "All",
    [ValidateRange(1, 65535)][int]$BridgePort = 8877,
    [ValidateRange(1, 65535)][int]$ControlPort = 8878,
    [ValidateRange(1, 65535)][int]$SessionPort = 8879,
    [string]$DataDir = "",
    [switch]$EnablePersistentTasks,
    [switch]$EnableRemoteTaskDeletion,
    [string]$Node = "node"
)

$ErrorActionPreference = "Stop"
$script = Join-Path $PSScriptRoot "node\manage-services-node.mjs"
$nodeExe = (Get-Command $Node -ErrorAction Stop).Source
$arguments = @($script, $Action, $Service, "--bridge-port", $BridgePort, "--control-port", $ControlPort, "--session-port", $SessionPort)
if ($DataDir) { $arguments += @("--data-dir", $DataDir) }
if ($EnablePersistentTasks) { $arguments += @("--persistent-tasks", "true") }
if ($EnableRemoteTaskDeletion) { $arguments += @("--remote-task-deletion", "true") }
& $nodeExe $arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
