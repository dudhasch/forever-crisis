using './main.bicep'

param workload = readEnvironmentVariable('FFC_WORKLOAD', 'fc')
param env = readEnvironmentVariable('FFC_ENV', 'prd')
param location = readEnvironmentVariable('AZURE_LOCATION', 'westeurope')
param repositoryUrl = readEnvironmentVariable('FFC_REPOSITORY_URL', '')
param customDomain = readEnvironmentVariable('FFC_CUSTOM_DOMAIN', '')
param githubRepo = readEnvironmentVariable('FFC_GITHUB_REPO', '')
param adminPrincipalId = readEnvironmentVariable('FFC_ADMIN_PRINCIPAL_ID', '')
param telemetryEnabled = true
param telemetryRetentionDays = 180
