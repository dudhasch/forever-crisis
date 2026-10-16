// FF7 Forever Crisis: Azure Static Web App (Free) with managed Functions (api/), a Storage account whose
// Table Storage holds cloud saves ("saves") and opt-in telemetry ("telemetry"), a Key Vault for the CI secrets and
// two user-assigned identities GitHub Actions signs in as (OIDC, no stored Azure credentials). See infra/README.md.
targetScope = 'resourceGroup'

@description('Short workload name used in every resource name (lowercase letters and digits).')
@minLength(2)
@maxLength(8)
param workload string = 'fc'

@description('Environment part of the resource names.')
@allowed(['prd', 'dev'])
param env string = 'prd'

@description('Region of the Static Web App. Free tier regions: westus2, centralus, eastus2, westeurope, eastasia.')
@allowed(['westus2', 'centralus', 'eastus2', 'westeurope', 'eastasia'])
param location string = 'westeurope'

@description('Region of the Storage account (defaults to the Static Web App region).')
param storageLocation string = location

@description('Public GitHub repository URL (informational; deployment uses the token and GitHub Actions).')
param repositoryUrl string = ''

@description('Optional custom domain, e.g. play.example.org (needs a CNAME to the default hostname first). Empty = none.')
param customDomain string = ''

@description('Collect opt-in telemetry at all (the game still asks every player first).')
param telemetryEnabled bool = true

@description('Delete telemetry rows older than this many days (done by the API on write).')
@minValue(1)
@maxValue(730)
param telemetryRetentionDays int = 180

@description('GitHub repository (owner/name) the CI identities trust: pushes to main and pull requests. Empty = no identities.')
param githubRepo string = ''

@description('Object id of a user or group that may manage the Key Vault secrets (Key Vault Secrets Officer). Empty = none.')
param adminPrincipalId string = ''

@description('Tags for every resource.')
param tags object = { app: 'forever-crisis' }

var regionCodes = { westus2: 'wus2', centralus: 'cus', eastus2: 'eus2', westeurope: 'weu', eastasia: 'ea' }
var suffix = '${workload}-${env}-${regionCodes[location]}'
var unique = uniqueString(resourceGroup().id)
var storageName = take('st${workload}${env}${unique}', 24)

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: storageLocation
  tags: tags
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: true // Free-tier managed Functions have no managed identity: the API uses a connection string
    supportsHttpsTrafficOnly: true
    accessTier: 'Hot'
  }
}

// The extractor's data pack (a recipe of ids, offsets and hashes, with no text, models, textures or audio; see docs/PUBLISHING.md) lives apart from
// the saves account: a second Storage account with one anonymous-read container, no keys in the app.
var dataStorageName = take('st${workload}data${unique}', 24)

resource dataStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: dataStorageName
  location: storageLocation
  tags: tags
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: true // only the ffcx-data container below is public; the installer pins each pack by SHA-256
    supportsHttpsTrafficOnly: true
    accessTier: 'Hot'
  }
}

resource dataBlobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: dataStorage
  name: 'default'
}

resource dataContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: dataBlobs
  name: 'ffcx-data'
  properties: { publicAccess: 'Blob' } // anonymous read of single blobs, no listing
}

resource tables 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource savesTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tables
  name: 'saves'
}

resource telemetryTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tables
  name: 'telemetry'
}

resource site 'Microsoft.Web/staticSites@2023-12-01' = {
  name: 'swa-${suffix}-001'
  location: location
  tags: union(tags, { 'azd-service-name': 'web' })
  sku: { name: 'Free', tier: 'Free' }
  properties: {
    repositoryUrl: empty(repositoryUrl) ? null : repositoryUrl
    branch: empty(repositoryUrl) ? null : 'main'
    provider: 'None' // deployed by .github/workflows/deploy-swa.yml with the deployment token
    stagingEnvironmentPolicy: 'Enabled' // pull request previews (Free tier: up to 3)
    allowConfigFileUpdates: true
  }
}

resource siteSettings 'Microsoft.Web/staticSites/config@2023-12-01' = {
  parent: site
  name: 'appsettings'
  properties: {
    STORAGE_CONNECTION: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'
    TELEMETRY_ENABLED: telemetryEnabled ? '1' : '0'
    TELEMETRY_RETENTION_DAYS: string(telemetryRetentionDays)
  }
}

resource domain 'Microsoft.Web/staticSites/customDomains@2023-12-01' = if (!empty(customDomain)) {
  parent: site
  name: empty(customDomain) ? 'unused.invalid' : customDomain
  properties: {}
}

// ---- Key Vault: the SWA deployment token for the workflows (read with the identities below)

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: take('kv-${workload}-${env}-${unique}', 24)
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    publicNetworkAccess: 'Enabled' // GitHub-hosted runners have no fixed addresses
  }
}

resource tokenSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'swa-deployment-token'
  properties: { value: site.listSecrets().properties.apiKey, contentType: 'Azure Static Web Apps deployment token' }
}

// ---- GitHub Actions identities (federated credentials) and their roles

var deployIdentities = !empty(githubRepo)
var githubIssuer = 'https://token.actions.githubusercontent.com'
var roles = {
  contributor: 'b24988ac-6180-42a0-ab88-20f7382dd24c'
  reader: 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
  kvSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6'
  kvSecretsOfficer: 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
  blobDataContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
}

resource idMain 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = if (deployIdentities) {
  name: 'id-${workload}-gh-main'
  location: location
  tags: tags
}

resource idMainFed 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = if (deployIdentities) {
  parent: idMain
  name: 'github-main'
  properties: {
    issuer: githubIssuer
    subject: 'repo:${githubRepo}:ref:refs/heads/main'
    audiences: ['api://AzureADTokenExchange']
  }
}

resource idPr 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = if (deployIdentities) {
  name: 'id-${workload}-gh-pr'
  location: location
  tags: tags
}

resource idPrFed 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = if (deployIdentities) {
  parent: idPr
  name: 'github-pr'
  properties: {
    issuer: githubIssuer
    subject: 'repo:${githubRepo}:pull_request'
    audiences: ['api://AzureADTokenExchange']
  }
}

// main: manages the site (deploy, token, settings), uploads data packs, reads the vault.
resource mainSite 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployIdentities) {
  scope: site
  name: guid(site.id, 'id-${workload}-gh-main', roles.contributor)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.contributor)
    principalId: idMain!.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource mainData 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployIdentities) {
  scope: dataStorage
  name: guid(dataStorage.id, 'id-${workload}-gh-main', roles.blobDataContributor)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.blobDataContributor)
    principalId: idMain!.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource mainVault 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployIdentities) {
  scope: vault
  name: guid(vault.id, 'id-${workload}-gh-main', roles.kvSecretsUser)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.kvSecretsUser)
    principalId: idMain!.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// pr: reads the resource group (what-if, checks) and the deployment token for preview environments.
resource prGroup 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployIdentities) {
  name: guid(resourceGroup().id, 'id-${workload}-gh-pr', roles.reader)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.reader)
    principalId: idPr!.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource prVault 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployIdentities) {
  scope: vault
  name: guid(vault.id, 'id-${workload}-gh-pr', roles.kvSecretsUser)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.kvSecretsUser)
    principalId: idPr!.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// The person running the deployment may manage the vault's secrets.
resource adminVault 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(adminPrincipalId)) {
  scope: vault
  name: guid(vault.id, adminPrincipalId, roles.kvSecretsOfficer)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.kvSecretsOfficer)
    principalId: adminPrincipalId
  }
}

output siteUrl string = 'https://${site.properties.defaultHostname}'
output siteName string = site.name
output defaultHostname string = site.properties.defaultHostname
output storageAccount string = storage.name

@description('Put this in extractor/data.lock.json ("base") and the DATA_BASE_URL Actions variable; upload packs with release-tools/publish-data.ps1.')
output dataBaseUrl string = '${dataStorage.properties.primaryEndpoints.blob}${dataContainer.name}'
output dataStorageAccount string = dataStorage.name

@description('The SWA deployment token is in this vault as the secret swa-deployment-token.')
output keyVaultName string = vault.name
output tenantId string = subscription().tenantId
output subscriptionId string = subscription().subscriptionId

@description('GitHub variable AZURE_CLIENT_ID for workflows on main.')
output mainClientId string = deployIdentities ? idMain!.properties.clientId : ''

@description('GitHub variable AZURE_CLIENT_ID_PR for pull request workflows.')
output prClientId string = deployIdentities ? idPr!.properties.clientId : ''
