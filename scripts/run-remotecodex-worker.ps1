param(
    [Parameter(Mandatory)]
    [string]$RepoRoot,

    [Parameter(Mandatory)]
    [string]$StdoutLog,

    [Parameter(Mandatory)]
    [string]$StderrLog
)

$ErrorActionPreference = 'Stop'

Push-Location $RepoRoot
try {
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & node 'src/index.js' 1>> $StdoutLog 2>> $StderrLog
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorActionPreference
    exit $exitCode
} finally {
    Pop-Location
}
