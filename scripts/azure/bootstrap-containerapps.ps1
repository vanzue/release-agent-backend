[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ResourceGroup,

  [Parameter(Mandatory = $true)]
  [string]$Location,

  [Parameter(Mandatory = $true)]
  [string]$AcrName,

  [Parameter(Mandatory = $true)]
  [string]$ContainerAppsEnvName,

  [Parameter(Mandatory = $true)]
  [string]$ApiAppName,

  [Parameter(Mandatory = $true)]
  [string]$WorkerAppName,

  # Secrets (do not commit these; pass via env vars or prompt)
  [string]$DatabaseUrl,

  [string]$ServiceBusConnectionString,

  # Worker GitHub token used as GITHUB_TOKEN (repo read access)
  [string]$GitHubToken,

  [string]$ServiceBusQueueName = "session-run",
  [string]$CorsOrigin = "",

  [switch]$SkipAcrBuild
)

$ErrorActionPreference = "Stop"

function Get-PlainTextFromSecureString {
  param([Parameter(Mandatory = $true)][securestring]$Secure)
  return (New-Object System.Net.NetworkCredential("", $Secure)).Password
}

while (-not $DatabaseUrl -or -not ($DatabaseUrl -match '^postgres(ql)?://')) {
  if ($DatabaseUrl) {
    Write-Host "DATABASE_URL must start with postgres:// or postgresql://" -ForegroundColor Yellow
  }
  Write-Host "Example: postgres://pgadmin:<password>@<server>.postgres.database.azure.com:5432/release_agent?sslmode=require" -ForegroundColor DarkGray
  $DatabaseUrl = Read-Host "DATABASE_URL (will be stored as Container App secret)"
}

while (-not $ServiceBusConnectionString -or -not ($ServiceBusConnectionString -match '^Endpoint=sb://')) {
  if ($ServiceBusConnectionString) {
    Write-Host "SERVICEBUS_CONNECTION_STRING should start with 'Endpoint=sb://'" -ForegroundColor Yellow
  }
  $sec = Read-Host "SERVICEBUS_CONNECTION_STRING (will be stored as Container App secret)" -AsSecureString
  $ServiceBusConnectionString = Get-PlainTextFromSecureString -Secure $sec
}

while (-not $GitHubToken -or -not ($GitHubToken -match '^(ghp_|github_pat_)')) {
  if ($GitHubToken) {
    Write-Host "GitHub token typically starts with ghp_ or github_pat_" -ForegroundColor Yellow
  }
  $sec = Read-Host "WORKER GitHub token (GITHUB_TOKEN)" -AsSecureString
  $GitHubToken = Get-PlainTextFromSecureString -Secure $sec
}

function Get-PlainTextFromSecureString {
  param([Parameter(Mandatory = $true)][securestring]$Secure)
  return (New-Object System.Net.NetworkCredential("", $Secure)).Password
}

function Assert-LastExit {
  param([string]$What)
  if ($LASTEXITCODE -ne 0) { throw $What }
}

function Install-AzCliExtension {
  param([string]$Name)
  az extension show --name $Name -o none 2>$null
  if ($LASTEXITCODE -eq 0) {
    return
  }
  az extension add --name $Name --upgrade -o none
  Assert-LastExit "Failed to install az extension: $Name"
}

function New-ResourceIfMissing {
  param(
    [string]$CheckCommand,
    [string]$CreateCommand,
    [string]$What
  )

  Invoke-Expression $CheckCommand | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Write-Host "$What already exists." -ForegroundColor DarkGray
    return
  }

  Write-Host "Creating $What..." -ForegroundColor Cyan
  Invoke-Expression $CreateCommand | Out-Null
  Assert-LastExit "Failed to create $What"
}

Install-AzCliExtension "containerapp"

# Prompt for missing secrets (avoids putting them into shell history)
if (-not $DatabaseUrl) {
  $DatabaseUrl = Read-Host "DATABASE_URL (stored as Container App secret)"
}
if (-not $ServiceBusConnectionString) {
  $sbSec = Read-Host "SERVICEBUS_CONNECTION_STRING (stored as Container App secret)" -AsSecureString
  $ServiceBusConnectionString = Get-PlainTextFromSecureString -Secure $sbSec
}
if (-not $GitHubToken) {
  $ghSec = Read-Host "WORKER GITHUB_TOKEN (stored as Container App secret)" -AsSecureString
  $GitHubToken = Get-PlainTextFromSecureString -Secure $ghSec
}

# Ensure RG exists
New-ResourceIfMissing `
  -CheckCommand "az group show -n $ResourceGroup -o none" `
  -CreateCommand "az group create -n $ResourceGroup -l $Location -o none" `
  -What "resource group $ResourceGroup"

# ACR
New-ResourceIfMissing `
  -CheckCommand "az acr show -g $ResourceGroup -n $AcrName -o none" `
  -CreateCommand "az acr create -g $ResourceGroup -n $AcrName -l $Location --sku Basic --admin-enabled false -o none" `
  -What "ACR $AcrName"

$acrId = (az acr show -g $ResourceGroup -n $AcrName --query id -o tsv).Trim()
$acrLoginServer = (az acr show -g $ResourceGroup -n $AcrName --query loginServer -o tsv).Trim()

# Container Apps Environment
New-ResourceIfMissing `
  -CheckCommand "az containerapp env show -g $ResourceGroup -n $ContainerAppsEnvName -o none" `
  -CreateCommand "az containerapp env create -g $ResourceGroup -n $ContainerAppsEnvName -l $Location --logs-destination none -o none" `
  -What "Container Apps environment $ContainerAppsEnvName"

# Build + push images to ACR (one time bootstrap convenience)
if (-not $SkipAcrBuild) {
  Write-Host "Building images in ACR (this may take a few minutes)..." -ForegroundColor Cyan
  Push-Location (Resolve-Path (Join-Path $PSScriptRoot "..\.."))
  try {
    # repo root for backend
    az acr build -g $ResourceGroup -r $AcrName -t "release-agent-api:bootstrap" -f "apps/api/Dockerfile" .
    Assert-LastExit "ACR build failed for API"

    az acr build -g $ResourceGroup -r $AcrName -t "release-agent-worker:bootstrap" -f "apps/worker/Dockerfile" .
    Assert-LastExit "ACR build failed for worker"
  } finally {
    Pop-Location
  }
}

# Create API app (ingress external)
$apiImage = "$acrLoginServer/release-agent-api:bootstrap"
$workerImage = "$acrLoginServer/release-agent-worker:bootstrap"

$apiExists = $false
az containerapp show -g $ResourceGroup -n $ApiAppName -o none 2>$null
if ($LASTEXITCODE -eq 0) { $apiExists = $true }

if (-not $apiExists) {
  Write-Host "Creating Container App $ApiAppName (API)..." -ForegroundColor Cyan
  az containerapp create `
    -g $ResourceGroup `
    -n $ApiAppName `
    --environment $ContainerAppsEnvName `
    --image $apiImage `
    --ingress external `
    --target-port 8080 `
    --registry-server $acrLoginServer `
    --registry-identity system `
    --secrets `
      database-url="$DatabaseUrl" `
      servicebus-conn="$ServiceBusConnectionString" `
    --env-vars `
      PORT=8080 `
      HOST=0.0.0.0 `
      DATABASE_URL=secretref:database-url `
      SERVICEBUS_CONNECTION_STRING=secretref:servicebus-conn `
      SERVICEBUS_SESSION_RUN_QUEUE=$ServiceBusQueueName `
      DB_POOL_MAX=10 `
      CORS_ORIGIN="$CorsOrigin" `
    -o none
  Assert-LastExit "Failed to create API container app"
} else {
  Write-Host "Updating Container App $ApiAppName (API secrets/env)..." -ForegroundColor Cyan
  az containerapp secret set -g $ResourceGroup -n $ApiAppName --secrets database-url="$DatabaseUrl" servicebus-conn="$ServiceBusConnectionString" -o none
  Assert-LastExit "Failed to set API secrets"

  az containerapp update -g $ResourceGroup -n $ApiAppName --set-env-vars PORT=8080 HOST=0.0.0.0 DATABASE_URL=secretref:database-url SERVICEBUS_CONNECTION_STRING=secretref:servicebus-conn SERVICEBUS_SESSION_RUN_QUEUE=$ServiceBusQueueName DB_POOL_MAX=10 CORS_ORIGIN="$CorsOrigin" -o none
  Assert-LastExit "Failed to update API env vars"
}

# Create worker app (no ingress)
$workerExists = $false
az containerapp show -g $ResourceGroup -n $WorkerAppName -o none 2>$null
if ($LASTEXITCODE -eq 0) { $workerExists = $true }

if (-not $workerExists) {
  Write-Host "Creating Container App $WorkerAppName (worker)..." -ForegroundColor Cyan
  az containerapp create `
    -g $ResourceGroup `
    -n $WorkerAppName `
    --environment $ContainerAppsEnvName `
    --image $workerImage `
    --registry-server $acrLoginServer `
    --registry-identity system `
    --secrets `
      database-url="$DatabaseUrl" `
      servicebus-conn="$ServiceBusConnectionString" `
      github-token="$GitHubToken" `
    --env-vars `
      DATABASE_URL=secretref:database-url `
      SERVICEBUS_CONNECTION_STRING=secretref:servicebus-conn `
      SERVICEBUS_SESSION_RUN_QUEUE=$ServiceBusQueueName `
      LOG_LEVEL=info `
      GITHUB_TOKEN=secretref:github-token `
    -o none
  Assert-LastExit "Failed to create worker container app"
} else {
  Write-Host "Updating Container App $WorkerAppName (worker secrets/env)..." -ForegroundColor Cyan
  az containerapp secret set -g $ResourceGroup -n $WorkerAppName --secrets database-url="$DatabaseUrl" servicebus-conn="$ServiceBusConnectionString" github-token="$GitHubToken" -o none
  Assert-LastExit "Failed to set worker secrets"

  az containerapp update -g $ResourceGroup -n $WorkerAppName --set-env-vars DATABASE_URL=secretref:database-url SERVICEBUS_CONNECTION_STRING=secretref:servicebus-conn SERVICEBUS_SESSION_RUN_QUEUE=$ServiceBusQueueName LOG_LEVEL=info GITHUB_TOKEN=secretref:github-token -o none
  Assert-LastExit "Failed to update worker env vars"
}

# Ensure ACR pull for both apps (best effort)
function Ensure-AcrPull {
  param([string]$AppName)

  $principalId = (az containerapp show -g $ResourceGroup -n $AppName --query identity.principalId -o tsv).Trim()
  if (-not $principalId) { return }

  az role assignment create --assignee-object-id $principalId --assignee-principal-type ServicePrincipal --role AcrPull --scope $acrId -o none 2>$null
  # Ignore errors (role may already exist)
}

Ensure-AcrPull -AppName $ApiAppName
Ensure-AcrPull -AppName $WorkerAppName

$apiFqdn = (az containerapp show -g $ResourceGroup -n $ApiAppName --query properties.configuration.ingress.fqdn -o tsv).Trim()
Write-Host "\nBootstrap complete." -ForegroundColor Green
Write-Host "ACR: $acrLoginServer" -ForegroundColor Green
Write-Host "API FQDN: $apiFqdn" -ForegroundColor Green
Write-Host "API App: $ApiAppName" -ForegroundColor Green
Write-Host "Worker App: $WorkerAppName" -ForegroundColor Green
