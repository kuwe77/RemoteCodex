param()

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $repoRoot '.remotecodex-runtime'
$supervisorPidFile = Join-Path $runtimeDir 'supervisor.pid'
$workerPidFile = Join-Path $runtimeDir 'worker.pid'
$stopFile = Join-Path $runtimeDir 'stop.flag'

function Get-RunningPid {
    param(
        [Parameter(Mandatory)]
        [string]$PidFile
    )

    if (-not (Test-Path $PidFile)) {
        return $null
    }

    $rawPid = (Get-Content -Path $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if (-not $rawPid) {
        return $null
    }

    $trimmedPid = $rawPid.ToString().Trim()
    if (-not $trimmedPid) {
        return $null
    }

    try {
        $process = Get-Process -Id ([int]$trimmedPid) -ErrorAction Stop
        return $process.Id
    } catch {
        return $null
    }
}

function Stop-ProcessTree {
    param(
        [Parameter(Mandatory)]
        [int]$TargetPid,

        [Parameter(Mandatory)]
        [string]$Label
    )

    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $null = & taskkill.exe /PID $TargetPid /T /F 2>$null
    $ErrorActionPreference = $previousErrorActionPreference

    if ($LASTEXITCODE -eq 0) {
        Write-Host "$Label stopped. PID: $TargetPid"
        return
    }

    if (-not (Get-Process -Id $TargetPid -ErrorAction SilentlyContinue)) {
        Write-Host "$Label was already stopped. PID: $TargetPid"
        return
    }

    throw "Failed to stop $Label PID $TargetPid."
}

New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
Set-Content -Path $stopFile -Value 'stop' -NoNewline

$workerPid = Get-RunningPid -PidFile $workerPidFile
$supervisorPid = Get-RunningPid -PidFile $supervisorPidFile

if (-not $workerPid -and -not $supervisorPid) {
    Write-Host 'RemoteCodex is not running.'
    Remove-Item $workerPidFile -Force -ErrorAction SilentlyContinue
    Remove-Item $supervisorPidFile -Force -ErrorAction SilentlyContinue
    Remove-Item $stopFile -Force -ErrorAction SilentlyContinue
    exit 0
}

if ($workerPid) {
    Stop-ProcessTree -TargetPid $workerPid -Label 'RemoteCodex worker'
}

if ($supervisorPid) {
    Stop-ProcessTree -TargetPid $supervisorPid -Label 'RemoteCodex supervisor'
}

Remove-Item $workerPidFile -Force -ErrorAction SilentlyContinue
Remove-Item $supervisorPidFile -Force -ErrorAction SilentlyContinue
Remove-Item $stopFile -Force -ErrorAction SilentlyContinue
