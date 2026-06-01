param(
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
$workerScript = Join-Path $PSScriptRoot 'run-remotecodex-worker.ps1'

New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
Remove-Item $stopFile -Force -ErrorAction SilentlyContinue

function Write-SupervisorLog {
    param(
        [Parameter(Mandatory)]
        [string]$Message
    )

    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $supervisorLog -Value "$timestamp $Message"
}

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

$existingSupervisorPid = Get-RunningPid -PidFile $supervisorPidFile
if ($existingSupervisorPid -and $existingSupervisorPid -ne $PID) {
    Write-SupervisorLog "Supervisor already running. pid=$existingSupervisorPid"
    exit 0
}

if (Test-RemoteCodexHealth) {
    Write-SupervisorLog 'RemoteCodex is already healthy. Supervisor start skipped.'
    exit 0
}

Set-Content -Path $supervisorPidFile -Value $PID -NoNewline
Write-SupervisorLog "Supervisor started. pid=$PID repo=$repoRoot"

try {
    while ($true) {
        if (Test-Path $stopFile) {
            Write-SupervisorLog 'Stop file detected before worker start.'
            break
        }

        $workerArgs = @(
            '-NoProfile',
            '-ExecutionPolicy Bypass',
            "-File `"$workerScript`"",
            "-RepoRoot `"$repoRoot`"",
            "-StdoutLog `"$stdoutLog`"",
            "-StderrLog `"$stderrLog`""
        ) -join ' '

        $worker = Start-Process `
            -FilePath 'powershell.exe' `
            -ArgumentList $workerArgs `
            -WorkingDirectory $repoRoot `
            -WindowStyle Hidden `
            -PassThru

        Set-Content -Path $workerPidFile -Value $worker.Id -NoNewline
        Write-SupervisorLog "Worker started. pid=$($worker.Id)"

        $worker.WaitForExit()
        $exitCode = $worker.ExitCode
        Remove-Item $workerPidFile -Force -ErrorAction SilentlyContinue

        if (Test-Path $stopFile) {
            Write-SupervisorLog "Worker exited after stop request. exitCode=$exitCode"
            break
        }

        Write-SupervisorLog "Worker exited unexpectedly. exitCode=$exitCode restartDelay=${RestartDelaySeconds}s"
        Start-Sleep -Seconds $RestartDelaySeconds
    }
} finally {
    Remove-Item $workerPidFile -Force -ErrorAction SilentlyContinue
    Remove-Item $supervisorPidFile -Force -ErrorAction SilentlyContinue
    Remove-Item $stopFile -Force -ErrorAction SilentlyContinue
    Write-SupervisorLog "Supervisor stopped. pid=$PID"
}
