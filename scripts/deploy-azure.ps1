[CmdletBinding()]
param(
  # Azure basics
  [string]$Location = "eastus",
  [string]$ResourceGroupName,
  [string]$NamePrefix = "releaseagent",

  # PostgreSQL Flexible Server
  [string]$PostgresLocation,
  [string]$PostgresServerName,
  [string]$PostgresDatabaseName = "release_agent",
  [string]$PostgresAdminUser = "pgadmin",
  [string]$PostgresAdminPassword,
  [string]$PostgresSkuName = "Standard_B1ms",
  [string]$PostgresVersion = "16",
  [int]$PostgresStorageSizeGb = 32,

  # Service Bus
  [string]$ServiceBusNamespaceName,
  [string]$ServiceBusQueueName = "session-run",
  [ValidateSet("Basic","Standard","Premium")]
  [string]$ServiceBusSku = "Standard",

  # Optional behavior
  [switch]$RunMigrations,
  [switch]$WriteEnvFiles
)

$ErrorActionPreference = "Stop"

function Assert-LastExit {
  param([string]$What)
  if ($LASTEXITCODE -ne 0) {
    throw $What
  }
}

function New-StrongPassword {
  param([int]$Length = 32)

  # IMPORTANT: `az` is a cmd shim on Windows; some characters (e.g. &()[]) can break argument parsing.
  # Keep this set cmd-safe and URL-safe; we still URL-encode when building DATABASE_URL.
  $alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"
  $bytes = New-Object byte[] $Length
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $chars = for ($i = 0; $i -lt $Length; $i++) {
    $alphabet[ $bytes[$i] % $alphabet.Length ]
  }
  -join $chars
}

function New-NameSuffix {
  # Short, lowercase, mostly numeric suffix to keep within Azure naming constraints.
  $stamp = Get-Date -Format "yyMMddHHmm"
  $rand = Get-Random -Minimum 100 -Maximum 999
  return "${stamp}${rand}"
}

function Require-Az {
  $null = Get-Command az -ErrorAction Stop
  $acct = az account show -o none 2>$null
  if ($LASTEXITCODE -ne 0) {
    throw "Azure CLI not logged in. Run 'az login' first."
  }
}

function Get-PublicIp {
  try {
    # External call; if it fails we still proceed (user can add firewall rules later).
    return (Invoke-RestMethod -Uri "https://api.ipify.org?format=text" -TimeoutSec 10).Trim()
  } catch {
    return $null
  }
}

Require-Az

$suffix = New-NameSuffix

$pgLocation = if ($PostgresLocation) { $PostgresLocation } else { $Location }

if (-not $ResourceGroupName) { $ResourceGroupName = "$NamePrefix-rg-$suffix" }
if (-not $PostgresServerName) { $PostgresServerName = "$NamePrefix-pg-$suffix" }
if (-not $ServiceBusNamespaceName) { $ServiceBusNamespaceName = "$NamePrefix-sb-$suffix" }

# Normalize names to meet Azure constraints where needed
$ServiceBusNamespaceName = $ServiceBusNamespaceName.ToLowerInvariant() -replace "[^a-z0-9-]", "-"
$PostgresServerName = $PostgresServerName.ToLowerInvariant() -replace "[^a-z0-9-]", "-"

if (-not $PostgresAdminPassword) { $PostgresAdminPassword = New-StrongPassword }

Write-Host "Using subscription:" -ForegroundColor Cyan
az account show --query "{name:name, id:id}" -o table

Write-Host "\nCreating resource group $ResourceGroupName in $Location..." -ForegroundColor Cyan
az group create -n $ResourceGroupName -l $Location -o table
Assert-LastExit "Failed to create resource group ($ResourceGroupName)."

Write-Host "\nEnsuring resource providers are registered..." -ForegroundColor Cyan
az provider register --namespace Microsoft.DBforPostgreSQL -o none
Assert-LastExit "Failed to register Microsoft.DBforPostgreSQL provider."

Write-Host "\nCreating PostgreSQL Flexible Server $PostgresServerName..." -ForegroundColor Cyan
# Create server with public access enabled so local dev machines (and Azure Container Apps later)
# can connect. We'll still lock down access via firewall rules.
az postgres flexible-server create `
  -g $ResourceGroupName `
  -n $PostgresServerName `
  -l $pgLocation `
  --tier Burstable `
  --sku-name $PostgresSkuName `
  --storage-size $PostgresStorageSizeGb `
  --version $PostgresVersion `
  --admin-user $PostgresAdminUser `
  --admin-password $PostgresAdminPassword `
  --public-access Enabled `
  --yes `
  -o none
Assert-LastExit "Failed to create Postgres flexible server in location '$pgLocation'. Try a different region (e.g. westus2, centralus, westeurope) or set -PostgresLocation."

Write-Host "\nAllow-listing required Postgres extensions..." -ForegroundColor Cyan
az postgres flexible-server parameter set -g $ResourceGroupName -s $PostgresServerName -n azure.extensions -v "pgcrypto" -o none
Assert-LastExit "Failed to set azure.extensions (pgcrypto)."

Write-Host "\nCreating database $PostgresDatabaseName..." -ForegroundColor Cyan
az postgres flexible-server db create -g $ResourceGroupName -s $PostgresServerName -d $PostgresDatabaseName -o none
Assert-LastExit "Failed to create Postgres database ($PostgresDatabaseName)."

# Firewall rules: allow current client IP if detectable, plus allow Azure services (0.0.0.0)
Write-Host "\nConfiguring Postgres firewall rules..." -ForegroundColor Cyan
$ip = Get-PublicIp
if ($ip) {
  az postgres flexible-server firewall-rule create -g $ResourceGroupName -n $PostgresServerName -r "client-$suffix" --start-ip-address $ip --end-ip-address $ip -o none
  Assert-LastExit "Failed to create Postgres firewall rule for client IP ($ip)."
  Write-Host "Allowed current public IP: $ip" -ForegroundColor DarkGray
} else {
  Write-Host "Could not detect public IP; skipping client firewall rule." -ForegroundColor Yellow
}
# '0.0.0.0' is the special rule to allow Azure services.
az postgres flexible-server firewall-rule create -g $ResourceGroupName -n $PostgresServerName -r "allow-azure-services" --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0 -o none
Assert-LastExit "Failed to create Postgres firewall rule for Azure services (0.0.0.0)."

Write-Host "\nCreating Service Bus namespace $ServiceBusNamespaceName ($ServiceBusSku)..." -ForegroundColor Cyan
az servicebus namespace create -g $ResourceGroupName -n $ServiceBusNamespaceName -l $Location --sku $ServiceBusSku -o table
Assert-LastExit "Failed to create Service Bus namespace ($ServiceBusNamespaceName)."

Write-Host "\nCreating Service Bus queue $ServiceBusQueueName..." -ForegroundColor Cyan
az servicebus queue create -g $ResourceGroupName --namespace-name $ServiceBusNamespaceName -n $ServiceBusQueueName -o table
Assert-LastExit "Failed to create Service Bus queue ($ServiceBusQueueName)."

$sbConn = az servicebus namespace authorization-rule keys list `
  -g $ResourceGroupName `
  --namespace-name $ServiceBusNamespaceName `
  -n RootManageSharedAccessKey `
  --query primaryConnectionString `
  -o tsv

$sbConn = ($sbConn ?? "").Trim()
$encodedDbUser = [System.Uri]::EscapeDataString($PostgresAdminUser)
$encodedDbPass = [System.Uri]::EscapeDataString($PostgresAdminPassword)

$pgHost = "$PostgresServerName.postgres.database.azure.com"
$databaseUrl = "postgres://${encodedDbUser}:${encodedDbPass}@$pgHost:5432/$PostgresDatabaseName?sslmode=require"

Write-Host "\n=== Output (copy into env) ===" -ForegroundColor Green
Write-Host ("DATABASE_URL=" + $databaseUrl)
Write-Host ("SERVICEBUS_CONNECTION_STRING=" + $sbConn)
Write-Host ("SERVICEBUS_SESSION_RUN_QUEUE=" + $ServiceBusQueueName)
Write-Host "================================" -ForegroundColor Green

if ($WriteEnvFiles) {
  $repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

  $apiEnvPath = Join-Path $repoRoot "apps\api\.env.azure"
  $workerEnvPath = Join-Path $repoRoot "apps\worker\.env.azure"

  @(
    "PORT=8080",
    "HOST=0.0.0.0",
    "DATABASE_URL=$databaseUrl",
    "DB_POOL_MAX=10"
  ) | Set-Content -Path $apiEnvPath -Encoding utf8

  @(
    "SERVICEBUS_CONNECTION_STRING=$sbConn",
    "SERVICEBUS_SESSION_RUN_QUEUE=$ServiceBusQueueName",
    "LOG_LEVEL=info",
    "DATABASE_URL=$databaseUrl",
    "GITHUB_TOKEN="
  ) | Set-Content -Path $workerEnvPath -Encoding utf8

  Write-Host "\nWrote env files:" -ForegroundColor Cyan
  Write-Host "- $apiEnvPath"
  Write-Host "- $workerEnvPath"
  Write-Host "NOTE: These contain secrets; do not commit them." -ForegroundColor Yellow
}

if ($RunMigrations) {
  $repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
  Write-Host "\nRunning DB migrations..." -ForegroundColor Cyan
  Push-Location $repoRoot
  try {
    $env:DATABASE_URL = $databaseUrl
    pnpm db:migrate
  } finally {
    Pop-Location
  }
}

Write-Host "\nDone." -ForegroundColor Green
