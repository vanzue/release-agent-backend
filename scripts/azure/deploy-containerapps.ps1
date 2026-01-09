[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ResourceGroup,

  [Parameter(Mandatory = $true)]
  [string]$AcrName,

  [Parameter(Mandatory = $true)]
  [string]$ApiAppName,

  [Parameter(Mandatory = $true)]
  [string]$WorkerAppName,

  [Parameter(Mandatory = $true)]
  [string]$ImageTag,

  # Secrets passed from CI (GitHub secrets)
  [Parameter(Mandatory = $true)]
  [string]$DatabaseUrl,

  [Parameter(Mandatory = $true)]
  [string]$ServiceBusConnectionString,

  [Parameter(Mandatory = $true)]
  [string]$WorkerGitHubToken,

  # LLM Configuration
  [string]$LlmProvider = "azure",
  [string]$LlmModel = "",
  [string]$AzureOpenAiEndpoint = "",
  [string]$AzureOpenAiApiKey = "",

  [string]$ServiceBusQueueName = "session-run",
  [string]$CommitRegenQueueName = "commit-regen",
  [string]$IssueSyncQueueName = "issue-sync",
  [string]$IssueReclusterQueueName = "issue-recluster",
  [int]$IssueAutoSyncIntervalMinutes = 30,
  [string]$IssueEmbeddingModelId = "",
  [string]$CorsOrigin = "",

  [switch]$SkipSecrets
)

$ErrorActionPreference = "Stop"

function Assert-LastExit {
  param([string]$What)
  if ($LASTEXITCODE -ne 0) { throw $What }
}

az extension add --name containerapp --upgrade -o none

$acrLoginServer = (az acr show -g $ResourceGroup -n $AcrName --query loginServer -o tsv).Trim()
if (-not $acrLoginServer) { throw "Unable to resolve ACR login server for $AcrName" }

$apiImage = "$acrLoginServer/release-agent-api:$ImageTag"
$workerImage = "$acrLoginServer/release-agent-worker:$ImageTag"

if (-not $SkipSecrets) {
  Write-Host "Setting secrets on Container Apps..." -ForegroundColor Cyan

  # Build API secrets - include Azure OpenAI key if provided
  $apiSecrets = "database-url=$DatabaseUrl", "servicebus-conn=$ServiceBusConnectionString"
  if ($AzureOpenAiApiKey) {
    $apiSecrets += "azure-openai-key=$AzureOpenAiApiKey"
  }
  az containerapp secret set -g $ResourceGroup -n $ApiAppName --secrets @apiSecrets -o none
  Assert-LastExit "Failed to set API secrets"

  # Build worker secrets - conditionally include Azure OpenAI key if provided
  $workerSecrets = "database-url=$DatabaseUrl", "servicebus-conn=$ServiceBusConnectionString", "github-token=$WorkerGitHubToken"
  if ($AzureOpenAiApiKey) {
    $workerSecrets += "azure-openai-key=$AzureOpenAiApiKey"
  }
  az containerapp secret set -g $ResourceGroup -n $WorkerAppName --secrets @workerSecrets -o none
  Assert-LastExit "Failed to set worker secrets"
}

Write-Host "Updating API image + env vars..." -ForegroundColor Cyan

# Build API env vars
$apiEnvVars = @(
  "PORT=8080",
  "HOST=0.0.0.0",
  "DATABASE_URL=secretref:database-url",
  "SERVICEBUS_CONNECTION_STRING=secretref:servicebus-conn",
  "SERVICEBUS_SESSION_RUN_QUEUE=$ServiceBusQueueName",
  "DB_POOL_MAX=10",
  "CORS_ORIGIN=$CorsOrigin"
)

if ($IssueEmbeddingModelId) {
  $apiEnvVars += "ISSUE_EMBEDDING_MODEL_ID=$IssueEmbeddingModelId"
}
if ($AzureOpenAiEndpoint) {
  $apiEnvVars += "AZURE_OPENAI_ENDPOINT=$AzureOpenAiEndpoint"
}
if ($AzureOpenAiApiKey) {
  $apiEnvVars += "AZURE_OPENAI_API_KEY=secretref:azure-openai-key"
}

az containerapp update `
  -g $ResourceGroup `
  -n $ApiAppName `
  --image $apiImage `
  --set-env-vars @apiEnvVars `
  -o none
Assert-LastExit "Failed to update API app"

Write-Host "Updating worker image + env vars..." -ForegroundColor Cyan

# Build worker env vars
$workerEnvVars = @(
  "DATABASE_URL=secretref:database-url",
  "SERVICEBUS_CONNECTION_STRING=secretref:servicebus-conn",
  "SERVICEBUS_SESSION_RUN_QUEUE=$ServiceBusQueueName",
  "SERVICEBUS_COMMIT_REGEN_QUEUE=$CommitRegenQueueName",
  "SERVICEBUS_ISSUE_SYNC_QUEUE=$IssueSyncQueueName",
  "SERVICEBUS_ISSUE_RECLUSTER_QUEUE=$IssueReclusterQueueName",
  "ISSUE_AUTO_SYNC_INTERVAL_MINUTES=$IssueAutoSyncIntervalMinutes",
  "LOG_LEVEL=info",
  "GITHUB_TOKEN=secretref:github-token",
  "LLM_PROVIDER=$LlmProvider"
)

if ($IssueEmbeddingModelId) {
  $workerEnvVars += "ISSUE_EMBEDDING_MODEL_ID=$IssueEmbeddingModelId"
}

if ($LlmModel) {
  $workerEnvVars += "LLM_MODEL=$LlmModel"
}
if ($AzureOpenAiEndpoint) {
  $workerEnvVars += "AZURE_OPENAI_ENDPOINT=$AzureOpenAiEndpoint"
}
if ($AzureOpenAiApiKey) {
  $workerEnvVars += "AZURE_OPENAI_API_KEY=secretref:azure-openai-key"
}

az containerapp update `
  -g $ResourceGroup `
  -n $WorkerAppName `
  --image $workerImage `
  --set-env-vars @workerEnvVars `
  -o none
Assert-LastExit "Failed to update worker app"

$apiFqdn = (az containerapp show -g $ResourceGroup -n $ApiAppName --query properties.configuration.ingress.fqdn -o tsv).Trim()
Write-Host "Deploy complete." -ForegroundColor Green
Write-Host "API image: $apiImage" -ForegroundColor Green
Write-Host "Worker image: $workerImage" -ForegroundColor Green
Write-Host "API FQDN: $apiFqdn" -ForegroundColor Green
