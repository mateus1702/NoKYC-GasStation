# Teardown stack (down -v) then bring it back: docker compose up -d
# Run: .\scripts\docker-reset.ps1
# Prod: .\scripts\docker-reset.ps1 -Prod
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
Write-Host "[docker-reset] compose file: $ComposeFile"

Write-Host "[docker-reset] step 1/2: down -v --remove-orphans"
if (Test-Path $envFile) {
    docker compose -f $ComposeFile --env-file $envFile down -v --remove-orphans
} else {
    docker compose -f $ComposeFile down -v --remove-orphans
}

if (-not (Test-Path $envFile)) {
    Write-Error "[docker-reset] .env not found at $envFile; up requires --env-file .env"
}

Write-Host "[docker-reset] step 2/2: up -d"
docker compose -f $ComposeFile --env-file $envFile up -d
