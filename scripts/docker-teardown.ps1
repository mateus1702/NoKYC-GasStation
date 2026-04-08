# Stop stack containers and remove named volumes (deploy-output, valkey-data, etc.).
# Run from repo root:  .\scripts\docker-teardown.ps1
# Prod compose:         .\scripts\docker-teardown.ps1 -Prod
param(
    [switch] $Prod
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$ComposeFile = if ($Prod) {
    "infra/docker/docker-compose.prod.yml"
} else {
    "infra/docker/docker-compose.yml"
}

$envFile = Join-Path $Root ".env"
Write-Host "[docker-teardown] compose file: $ComposeFile"

if (Test-Path $envFile) {
    docker compose -f $ComposeFile --env-file $envFile down -v --remove-orphans
} else {
    docker compose -f $ComposeFile down -v --remove-orphans
}
