param(
    [Parameter(Mandatory = $true)]
    [string]$BotToken,

    [string]$Model = 'gpt-5.4',

    [string]$WorkingDirectory = '',

    [switch]$RequirePairing
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot

if (-not $WorkingDirectory) {
    $WorkingDirectory = $repoRoot
}

$env:REMOTECODEX_TG_TOKEN = $BotToken
$env:REMOTECODEX_TG_MODEL = $Model
$env:REMOTECODEX_TG_CWD = $WorkingDirectory
$env:REMOTECODEX_TG_REQUIRE_PAIRING = if ($RequirePairing) { 'true' } else { 'false' }

Push-Location $repoRoot
try {
    & node --input-type=module -e @"
import { getServerSettings, setServerSettings } from './src/server-settings.js';

const current = getServerSettings();
const currentTelegram = current.channels?.telegram?.instances?.[0] || {};

const next = setServerSettings({
  channels: {
    ...current.channels,
    telegram: {
      instances: [
        {
          ...currentTelegram,
          id: 'default',
          label: currentTelegram.label || 'Default',
          enabled: true,
          mode: 'polling',
          botToken: process.env.REMOTECODEX_TG_TOKEN || '',
          pollingIntervalMs: Number.parseInt(currentTelegram.pollingIntervalMs || '2000', 10) || 2000,
          defaultRuntimeProvider: 'codex',
          model: process.env.REMOTECODEX_TG_MODEL || 'gpt-5.4',
          cwd: process.env.REMOTECODEX_TG_CWD || '',
          requirePairing: process.env.REMOTECODEX_TG_REQUIRE_PAIRING === 'true'
        }
      ]
    }
  }
});

console.log(JSON.stringify(next.channels.telegram.instances[0], null, 2));
"@
} finally {
    Pop-Location
}

try {
    Invoke-RestMethod -Method Post -Uri 'http://localhost:8081/api/agent-channels/refresh' -TimeoutSec 5 | Out-Null
    Write-Host 'Refreshed the running RemoteCodex channel providers.'
} catch {
    Write-Host 'Saved Telegram settings. Start or restart RemoteCodex to apply them.'
}
