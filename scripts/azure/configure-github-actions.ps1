[CmdletBinding()]
param(
  # Azure resource group that contains ACR + Container Apps
  [string]$ResourceGroup,

  # Optional: if you already created ACR/Container Apps, provide names to set GitHub repo variables.
  [string]$AcrName,
  [string]$ApiAppName,
  [string]$WorkerAppName,
  [string]$CorsOrigin = "",

  # GitHub branch to authorize for deployments (default: main)
  [string]$Branch = "main",

  # Optional override (auto-detected from git remote origin if omitted)
  [string]$GitHubRepo,

  # Secrets to store in GitHub (if omitted, you will be prompted)
  [string]$DatabaseUrl,
  [string]$ServiceBusConnectionString,
  [string]$WorkerGitHubToken,

  # If set, skip setting runtime app secrets (DATABASE_URL, SERVICEBUS_CONNECTION_STRING, WORKER_GITHUB_TOKEN)
  # Useful for non-interactive runs; you can set them later via `gh secret set`.
  [switch]$SkipRuntimeSecrets,

  # If set, also assigns AcrPush on the provided ACR (when it exists)
  [switch]$AssignAcrPush
)

$ErrorActionPreference = "Stop"

function Get-PlainTextFromSecureString {
  param([Parameter(Mandatory = $true)][securestring]$Secure)
  return (New-Object System.Net.NetworkCredential("", $Secure)).Password
}

function Assert-Tool {
  param([Parameter(Mandatory = $true)][string]$Exe)
  $cmd = Get-Command $Exe -ErrorAction SilentlyContinue
  if (-not $cmd) { throw "Required tool not found on PATH: $Exe" }
}

function Get-GitHubRepoFromOrigin {
  $origin = (git remote get-url origin 2>$null)
  if (-not $origin) { return $null }

  # Supports:
  #   git@github.com:owner/repo.git
  #   https://github.com/owner/repo.git
  $m = [regex]::Match($origin.Trim(), "(?:github\\.com[:/])(?<owner>[^/]+)/(?<repo>[^/\.]+)(?:\\.git)?$")
  if (-not $m.Success) { return $null }
  return "$($m.Groups['owner'].Value)/$($m.Groups['repo'].Value)"
}

function Set-GhSecret {
  param(
    [Parameter(Mandatory = $true)][string]$Repo,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Value
  )

  $out = & gh secret set $Name -R $Repo --body $Value 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "gh secret set failed for '$Name' in '$Repo': $out"
  }
}

function Set-GhVar {
  param(
    [Parameter(Mandatory = $true)][string]$Repo,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value
  )

  $out = & gh variable set $Name -R $Repo --body $Value 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "gh variable set failed for '$Name' in '$Repo': $out"
  }
}

function Get-OrCreate-EntraApp {
  param([Parameter(Mandatory = $true)][string]$DisplayName)

  $existing = az ad app list --display-name $DisplayName --query "[0].appId" -o tsv 2>$null
  if ($LASTEXITCODE -eq 0 -and $existing) {
    return $existing.Trim()
  }

  $created = az ad app create --display-name $DisplayName --sign-in-audience AzureADMyOrg --query appId -o tsv
  if ($LASTEXITCODE -ne 0 -or -not $created) {
    throw "Failed to create Entra application: $DisplayName"
  }
  return $created.Trim()
}

Assert-Tool az
Assert-Tool gh
Assert-Tool git

# Ensure authenticated
az account show -o none
if ($LASTEXITCODE -ne 0) { throw "Not logged into Azure CLI. Run: az login" }

gh auth status -h github.com 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Not logged into GitHub CLI. Run: gh auth login" }

$sub = az account show --query "{subscriptionId:id, tenantId:tenantId}" -o json | ConvertFrom-Json
$subscriptionId = $sub.subscriptionId
$tenantId = $sub.tenantId

if (-not $GitHubRepo) {
  $GitHubRepo = Get-GitHubRepoFromOrigin
}
if (-not $GitHubRepo) {
  throw "Unable to auto-detect GitHub repo from git remote origin. Pass -GitHubRepo owner/repo"
}

# Try to infer RG if omitted
if (-not $ResourceGroup) {
  $rgs = az group list --query "[].name" -o tsv
  $match = $rgs | Where-Object { $_ -like "releaseagent-rg-*" } | Select-Object -First 1
  if ($match) {
    $ResourceGroup = $match
  } else {
    $ResourceGroup = Read-Host "Azure Resource Group name"
  }
}

if (-not $SkipRuntimeSecrets) {
  # Prompt for missing secrets
  if (-not $DatabaseUrl) {
    $DatabaseUrl = Read-Host "DATABASE_URL (will be stored as GitHub secret)"
  }
  if (-not $ServiceBusConnectionString) {
    $sec = Read-Host "SERVICEBUS_CONNECTION_STRING (will be stored as GitHub secret)" -AsSecureString
    $ServiceBusConnectionString = Get-PlainTextFromSecureString -Secure $sec
  }
  if (-not $WorkerGitHubToken) {
    $sec = Read-Host "WORKER_GITHUB_TOKEN (will be stored as GitHub secret)" -AsSecureString
    $WorkerGitHubToken = Get-PlainTextFromSecureString -Secure $sec
  }
}

Write-Host "Configuring OIDC for $GitHubRepo on branch refs/heads/$Branch..." -ForegroundColor Cyan

$appDisplayName = "release-agent-backend-gha-oidc-$($ResourceGroup)"

$clientId = Get-OrCreate-EntraApp -DisplayName $appDisplayName
if (-not $clientId) { throw "Failed to resolve Entra application client id" }

# Ensure SP exists
az ad sp create --id $clientId -o none 2>$null | Out-Null

$spObjectId = (az ad sp show --id $clientId --query id -o tsv).Trim()
if (-not $spObjectId) { throw "Failed to resolve service principal object id" }

# Federated credential
$fc = @{
  name      = "github-actions-$Branch"
  issuer    = "https://token.actions.githubusercontent.com"
  subject   = "repo:$GitHubRepo:ref:refs/heads/$Branch"
  audiences = @("api://AzureADTokenExchange")
}

$tmp = New-TemporaryFile
try {
  $fc | ConvertTo-Json -Depth 5 | Set-Content -Path $tmp -Encoding utf8
  az ad app federated-credential create --id $clientId --parameters "@$tmp" -o none 2>$null
  if ($LASTEXITCODE -ne 0) {
    # Best effort: if it already exists, delete and recreate
    az ad app federated-credential delete --id $clientId --federated-credential-id $fc.name -o none 2>$null
    az ad app federated-credential create --id $clientId --parameters "@$tmp" -o none
  }
} finally {
  Remove-Item -Force $tmp -ErrorAction SilentlyContinue
}

# RBAC on RG
$rgId = (az group show -n $ResourceGroup --query id -o tsv).Trim()
if (-not $rgId) { throw "Unable to resolve resource group scope for $ResourceGroup" }

# Best-effort role assignment (ignore if exists)
az role assignment create --assignee-object-id $spObjectId --assignee-principal-type ServicePrincipal --role Contributor --scope $rgId -o none 2>$null | Out-Null

if ($AssignAcrPush -and $AcrName) {
  az acr show -g $ResourceGroup -n $AcrName -o none 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) {
    $acrId = (az acr show -g $ResourceGroup -n $AcrName --query id -o tsv).Trim()
    if ($acrId) {
      az role assignment create --assignee-object-id $spObjectId --assignee-principal-type ServicePrincipal --role AcrPush --scope $acrId -o none 2>$null | Out-Null
    }
  }
}

Write-Host "Writing GitHub repo secrets + variables..." -ForegroundColor Cyan

# Azure auth secrets used by azure/login@v2
Set-GhSecret -Repo $GitHubRepo -Name "AZURE_CLIENT_ID" -Value $clientId
Set-GhSecret -Repo $GitHubRepo -Name "AZURE_TENANT_ID" -Value $tenantId
Set-GhSecret -Repo $GitHubRepo -Name "AZURE_SUBSCRIPTION_ID" -Value $subscriptionId

if (-not $SkipRuntimeSecrets) {
  # App secrets used at runtime
  Set-GhSecret -Repo $GitHubRepo -Name "DATABASE_URL" -Value $DatabaseUrl
  Set-GhSecret -Repo $GitHubRepo -Name "SERVICEBUS_CONNECTION_STRING" -Value $ServiceBusConnectionString
  Set-GhSecret -Repo $GitHubRepo -Name "WORKER_GITHUB_TOKEN" -Value $WorkerGitHubToken
} else {
  Write-Host "Skipped runtime app secrets. Set them later:" -ForegroundColor Yellow
  Write-Host "  gh secret set DATABASE_URL -R $GitHubRepo" -ForegroundColor Yellow
  Write-Host "  gh secret set SERVICEBUS_CONNECTION_STRING -R $GitHubRepo" -ForegroundColor Yellow
  Write-Host "  gh secret set WORKER_GITHUB_TOKEN -R $GitHubRepo" -ForegroundColor Yellow
}

# Vars referenced by workflow
Set-GhVar -Repo $GitHubRepo -Name "AZURE_RESOURCE_GROUP" -Value $ResourceGroup
if ($AcrName) { Set-GhVar -Repo $GitHubRepo -Name "ACR_NAME" -Value $AcrName }
if ($ApiAppName) { Set-GhVar -Repo $GitHubRepo -Name "ACA_API_APP_NAME" -Value $ApiAppName }
if ($WorkerAppName) { Set-GhVar -Repo $GitHubRepo -Name "ACA_WORKER_APP_NAME" -Value $WorkerAppName }
Set-GhVar -Repo $GitHubRepo -Name "CORS_ORIGIN" -Value $CorsOrigin

Write-Host "Done." -ForegroundColor Green
Write-Host "Repo: $GitHubRepo" -ForegroundColor Green
Write-Host "AZURE_CLIENT_ID: $clientId" -ForegroundColor Green
Write-Host "AZURE_TENANT_ID: $tenantId" -ForegroundColor Green
Write-Host "AZURE_SUBSCRIPTION_ID: $subscriptionId" -ForegroundColor Green
Write-Host "RBAC: Contributor on $ResourceGroup" -ForegroundColor Green
Write-Host "Next: push to main to trigger workflow in .github/workflows/deploy-backend.yml" -ForegroundColor Green

exit 0
