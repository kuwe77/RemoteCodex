param(
    [switch]$Background,
    [int]$RestartDelaySeconds = 5
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $repoRoot '.remotecodex-runtime'
$healthUrl = 'http://localhost:8081/health'
$stdoutLog = Join-Path $repoRoot 'remotecodex.stdout.log'
$stderrLog = Join-Path $repoRoot 'remotecodex.stderr.log'
$supervisorLog = Join-Path $repoRoot 'remotecodex.supervisor.log'
$supervisorPidFile = Join-Path $runtimeDir 'supervisor.pid'
$workerPidFile = Join-Path $runtimeDir 'worker.pid'
$stopFile = Join-Path $runtimeDir 'stop.flag'
$supervisorScript = Join-Path $PSScriptRoot 'run-remotecodex-supervisor.ps1'

function Test-RemoteCodexHealth {
    try {
        return Invoke-RestMethod -Method Get -Uri $healthUrl -TimeoutSec 3
    } catch {
        return $null
    }
}

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

$health = Test-RemoteCodexHealth
if ($health) {
    Write-Host 'RemoteCodex is already running at http://localhost:8081'
    Write-Host ($health | ConvertTo-Json -Depth 5)
    exit 0
}

if ($Background) {
    $supervisorPid = Get-RunningPid -PidFile $supervisorPidFile

    if (-not $supervisorPid) {
        New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
        Remove-Item $stopFile -Force -ErrorAction SilentlyContinue

        $supervisorArgs = @(
            '-NoProfile',
            '-ExecutionPolicy Bypass',
            "-File `"$supervisorScript`"",
            "-RestartDelaySeconds $RestartDelaySeconds"
        ) -join ' '

        Start-Process `
            -FilePath 'powershell.exe' `
            -ArgumentList $supervisorArgs `
            -WorkingDirectory $repoRoot `
            -WindowStyle Hidden | Out-Null

        Write-Host 'Starting RemoteCodex supervisor...'
    } else {
        Write-Host "RemoteCodex supervisor is already running. PID: $supervisorPid"
    }

    $deadline = (Get-Date).AddSeconds(20)
    do {
        Start-Sleep -Seconds 1
        $health = Test-RemoteCodexHealth
    } while (-not $health -and (Get-Date) -lt $deadline)

    if ($health) {
        $supervisorPid = Get-RunningPid -PidFile $supervisorPidFile
        $workerPid = Get-RunningPid -PidFile $workerPidFile
        Write-Host 'RemoteCodex started in background.'
        if ($supervisorPid) {
            Write-Host "Supervisor PID: $supervisorPid"
        }
        if ($workerPid) {
            Write-Host "Worker PID: $workerPid"
        }
        Write-Host 'Dashboard: http://localhost:8081'
        Write-Host "Logs: $stdoutLog, $stderrLog, and $supervisorLog"
        exit 0
    }

    Write-Host 'RemoteCodex did not become healthy in time. Check:'
    Write-Host "  $stdoutLog"
    Write-Host "  $stderrLog"
    Write-Host "  $supervisorLog"
    exit 1
}

Push-Location $repoRoot
try {
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & node src/index.js
    $ErrorActionPreference = $previousErrorActionPreference
} finally {
    Pop-Location
}
