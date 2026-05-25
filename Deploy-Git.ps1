#Requires -Version 5.1
<#
.SYNOPSIS
  Stages, commits, and pushes MyPools modifications to GitHub.
  Polls the VPS over SSH until the remote codebase matches the new commit hash,
  then verifies production container health and HTTPS connectivity.
.PARAMETER CommitMessage
  The commit message for local modifications.
.PARAMETER SnapshotName
  The name of a recovery snapshot to restore locally and deploy.
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$SourcePath,
    [Parameter(Mandatory = $false)]
    [string]$SnapshotName,
    [string]$CommitMessage = "Deploy from Snapshot Recovery Panel",
    [switch]$OverwriteDatabase,
    [string]$ContractorSlug,
    [switch]$GitOnly
)

$ErrorActionPreference = "Continue"
$localRepo = (Resolve-Path $SourcePath).Path
$ProjectName = Split-Path -Leaf $localRepo

# Resolve Tools
function Get-ToolPath {
    param([string]$ToolName)
    $projTools = Join-Path $localRepo "tools\$ToolName"
    if (Test-Path $projTools) { return $projTools }
    $globalTools = Join-Path $PSScriptRoot "tools\$ToolName"
    if (Test-Path $globalTools) { return $globalTools }
    $sharedToolsScript = Join-Path $localRepo "scripts\_Mypools-Root.ps1"
    if (Test-Path $sharedToolsScript) {
        try {
            . $sharedToolsScript
            if ($ToolName -ieq "plink.exe" -and (Get-Command Get-MypoolsPlinkPath -ErrorAction SilentlyContinue)) {
                return (Get-MypoolsPlinkPath)
            }
            if ($ToolName -ieq "pscp.exe" -and (Get-Command Get-MypoolsPscpPath -ErrorAction SilentlyContinue)) {
                return (Get-MypoolsPscpPath)
            }
        } catch {}
    }
    $cmd = Get-Command $ToolName -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $ToolName # Fallback to path execution
}

$plink = Get-ToolPath "plink.exe"
$pscp  = Get-ToolPath "pscp.exe"

function Assert-ToolAvailable {
    param(
        [string]$ToolPath,
        [string]$ToolName
    )

    if ([System.IO.Path]::IsPathRooted($ToolPath) -or $ToolPath.Contains('\') -or $ToolPath.Contains('/')) {
        if (-not (Test-Path $ToolPath)) {
            throw "Missing $ToolName at $ToolPath. Add PuTTY $ToolName under project tools\ or ESSOP tools\."
        }
        return
    }

    if (-not (Get-Command $ToolPath -ErrorAction SilentlyContinue)) {
        throw "Missing $ToolName. Add PuTTY $ToolName under project tools\, ESSOP tools\, or PATH."
    }
}

Assert-ToolAvailable -ToolPath $plink -ToolName "plink.exe"
Assert-ToolAvailable -ToolPath $pscp -ToolName "pscp.exe"

# Try loading custom configuration
$settingsPath = Join-Path $localRepo ".local\settings.json"
$secretPath = Join-Path $localRepo ".local\ssh.secret.txt"
$settings = $null
if (Test-Path $settingsPath) {
    try {
        $settings = Get-Content -Raw $settingsPath | ConvertFrom-Json
        Write-Host "Loaded configuration from settings.json" -ForegroundColor DarkGray
    } catch {
        Write-Host "Warning: Failed to parse settings.json. Using defaults." -ForegroundColor Yellow
    }
}

$hostIp = if ($env:MYSPOOLS_SSH_HOST) { $env:MYSPOOLS_SSH_HOST }
          elseif ($settings -and $settings.sshHost) { $settings.sshHost }
          else { "152.42.220.5" }

$user = if ($env:MYSPOOLS_SSH_USER) { $env:MYSPOOLS_SSH_USER }
        elseif ($settings -and $settings.sshUser) { $settings.sshUser }
        else { "root" }

$hostKey = if ($env:MYSPOOLS_SSH_HOSTKEY) { $env:MYSPOOLS_SSH_HOSTKEY }
           elseif ($settings -and $settings.sshHostKey) { $settings.sshHostKey }
           else { "SHA256:ZJmY20MEfjIPQ9I3uWA4Thql8y70nQxjY6za9LMiDBg" }

$pw = ""
if (Test-Path $secretPath) {
    try {
        $pw = (Get-Content -Raw $secretPath).Trim()
    } catch {}
}
if (-not $pw -and $settings -and $settings.sshPassword) {
    $pw = $settings.sshPassword
}
if (-not $pw) {
    $sharedSecretsScript = Join-Path $localRepo "scripts\_Mypools-Root.ps1"
    if (Test-Path $sharedSecretsScript) {
        try {
            . $sharedSecretsScript
            $pw = Get-MypoolsSshPassword
        } catch {}
    }
}

if (-not $pw) {
    throw "VPS SSH password not found. Please ensure it is configured in Settings or .local\ssh.secret.txt exists."
}

if ($ContractorSlug -and $OverwriteDatabase) {
    throw "Use either -OverwriteDatabase (full DB) or -ContractorSlug (single contractor), not both."
}

function Normalize-ContractorSlug {
    param([string]$InputSlug)

    $slug = $InputSlug.Trim().Trim('/')
    if ($slug -match '^https?://[^/]+/(.+)$') {
        $slug = $Matches[1]
    }
    $slug = $slug.Trim('/')
    if ($slug.Contains('/')) {
        $slug = ($slug -split '/')[-1]
    }
    return $slug.ToLowerInvariant()
}

function Get-ComposePhpContainer {
    param(
        [string]$ComposeProject,
        [string]$Label
    )

    $phpPod = @(podman ps --filter "label=io.podman.compose.project=$ComposeProject" --format "{{.Names}}" | Where-Object { $_ -match "_php_" } | Select-Object -First 1)
    if (-not $phpPod) {
        throw "${Label} PHP container ($ComposeProject) not running."
    }
    return $phpPod
}

function Invoke-RedisFlush {
    param(
        [string]$ComposeProject,
        [switch]$Remote
    )

    if ($Remote) {
        $cmd = "podman exec ${ComposeProject}_redis_1 redis-cli FLUSHALL >/dev/null 2>&1 || true"
        & $plink -ssh "${user}@${hostIp}" -batch -hostkey $hostKey -pw $pw $cmd 2>$null | Out-Null
        return
    }

    $redisPod = @(podman ps --filter "label=io.podman.compose.project=$ComposeProject" --format "{{.Names}}" | Where-Object { $_ -match "_redis_" } | Select-Object -First 1)
    if ($redisPod) {
        podman exec $redisPod redis-cli FLUSHALL 2>$null | Out-Null
    }
}

function Invoke-ContractorProductionImport {
    if (-not $script:ContractorSlugNormalized) {
        throw "Contractor slug is not set for production import."
    }

    Write-Host "Importing contractor '$($script:ContractorSlugNormalized)' on production..." -ForegroundColor Cyan
    $prodEnv = Read-ProductionComposeEnv -ProjPath $localRepo
    $phpProject = if ($prodEnv['COMPOSE_PROJECT_NAME']) { $prodEnv['COMPOSE_PROJECT_NAME'] } else { "$($ProjectName.ToLower())-pod" }

    if ($script:ContractorBundleLocal -and (Test-Path $script:ContractorBundleLocal)) {
        Write-Host "Ensuring contractor bundle is present on VPS..." -ForegroundColor DarkGray
        & $pscp -pw $pw -hostkey $hostKey -q -batch $script:ContractorBundleLocal "${user}@${hostIp}:${vpsInstallRoot}/contractor-sync.json" | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to upload contractor bundle before import."
        }
    }

    $importCmd = "test -f ${vpsInstallRoot}/contractor-sync.json || exit 2; cp ${vpsInstallRoot}/scripts/sync-contractor-data.php ${vpsInstallRoot}/wordpress/sync-contractor-data.php && cp ${vpsInstallRoot}/contractor-sync.json ${vpsInstallRoot}/wordpress/contractor-sync.json && podman exec ${phpProject}_php_1 php /var/www/html/sync-contractor-data.php import /var/www/html/contractor-sync.json; ec=`$?; rm -f ${vpsInstallRoot}/wordpress/sync-contractor-data.php ${vpsInstallRoot}/wordpress/contractor-sync.json ${vpsInstallRoot}/contractor-sync.json; podman exec ${phpProject}_redis_1 redis-cli FLUSHALL >/dev/null 2>&1 || true; exit `$ec"
    $importOutput = & $plink -ssh "${user}@${hostIp}" -batch -hostkey $hostKey -pw $pw $importCmd 2>&1
    if ($importOutput) { Write-Host $importOutput -ForegroundColor DarkGray }
    if ($LASTEXITCODE -ne 0) {
        throw "Contractor import failed on production for '$($script:ContractorSlugNormalized)'."
    }
    Write-Host "Contractor data imported on production." -ForegroundColor Green
}

function Sync-ContractorUploadFiles {
    param(
        [string]$BundleJsonPath,
        [string]$ProjPath
    )

    if (-not (Test-Path $BundleJsonPath)) { return }

    try {
        $bundle = Get-Content -Raw $BundleJsonPath | ConvertFrom-Json
    } catch {
        Write-Warning "Could not parse contractor bundle for media sync."
        return
    }

    $paths = @($bundle.upload_paths | Where-Object { $_ })
    if ($paths.Count -eq 0) { return }

    $envVars = Read-ComposeEnv -ProjPath $ProjPath
    $prodEnv = Read-ProductionComposeEnv -ProjPath $ProjPath
    $localUploads = $envVars['UPLOADS_PATH']
    if (-not $localUploads) { $localUploads = 'wordpress/wp-content/uploads' }
    if ($localUploads.StartsWith('./')) {
        $localUploads = Join-Path $ProjPath $localUploads.Substring(2)
    } elseif (-not [System.IO.Path]::IsPathRooted($localUploads)) {
        $localUploads = Join-Path $ProjPath $localUploads
    }

    $remoteUploads = $prodEnv['UPLOADS_PATH']
    if (-not $remoteUploads) { $remoteUploads = '/home/saleam/htdocs/mypools.co.za/wp-content/uploads' }

    Write-Host "Syncing $($paths.Count) contractor media file(s) to production uploads..." -ForegroundColor Cyan
    foreach ($relPath in $paths) {
        $relPath = ($relPath -replace '\\', '/').TrimStart('/')
        if ($relPath -eq '') { continue }

        $localFile = Join-Path $localUploads ($relPath -replace '/', [System.IO.Path]::DirectorySeparatorChar)
        if (-not (Test-Path $localFile)) {
            Write-Warning "Skipping missing local upload: $relPath"
            continue
        }

        $remoteDir = Split-Path $relPath -Parent
        if ($remoteDir) {
            $mkdirCmd = "mkdir -p '${remoteUploads}/${remoteDir}'"
            & $plink -ssh "${user}@${hostIp}" -batch -hostkey $hostKey -pw $pw $mkdirCmd 2>$null | Out-Null
        }

        Write-Host "  ↑ $relPath" -ForegroundColor DarkGray
        & $pscp -pw $pw -hostkey $hostKey -q -batch $localFile "${user}@${hostIp}:${remoteUploads}/${relPath}" 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Failed to upload media file: $relPath"
        }
    }
}

$vpsInstallRoot = if ($settings -and $settings.vpsInstallRoot) { $settings.vpsInstallRoot }
                  else { "/opt/$($ProjectName.ToLower())" }

$siteUrl = if ($settings -and $settings.siteUrl) { $settings.siteUrl }
           else { "https://$($ProjectName.ToLower()).co.za" }

Write-Host "=== Git Deployment & Production Verification Pipeline ==="  -ForegroundColor Cyan
Write-Host "Local Repository : $localRepo"                               -ForegroundColor White
Write-Host "Target VPS       : ${user}@${hostIp}"                        -ForegroundColor White
Write-Host "Commit Message   : $CommitMessage"                           -ForegroundColor White
Write-Host "Snapshot Deploy  : $($OverwriteDatabase.IsPresent)"          -ForegroundColor White
if ($ContractorSlug) {
Write-Host "Contractor Sync  : $ContractorSlug"                          -ForegroundColor White
}
if ($SnapshotName) {
Write-Host "Source Snapshot   : $SnapshotName"                            -ForegroundColor White
}

# ----------------------------------------------------
# PRE-DEPLOYMENT: Local Restore of Selected Snapshot
# ----------------------------------------------------
if ($SnapshotName -and -not $GitOnly) {
    $snapsPath = Join-Path $localRepo "Snapshots"
    $snapshotDir = Join-Path $snapsPath $SnapshotName
    if (-not (Test-Path $snapshotDir)) {
        # Fallback to legacy project-relative .snapshots
        $snapsPath = Join-Path $localRepo ".snapshots"
        $snapshotDir = Join-Path $snapsPath $SnapshotName
    }
    if (-not (Test-Path $snapshotDir)) {
        # Fallback to C:\snapshots\<ProjectName>
        $snapshotDir = Join-Path "C:\snapshots\$ProjectName" $SnapshotName
    }
    if (-not (Test-Path $snapshotDir)) {
        throw "Snapshot directory not found at $snapshotDir"
    }
    
    Write-Host "`n>>> [PRE-DEPLOYMENT] Restoring snapshot '$SnapshotName' locally prior to deployment..." -ForegroundColor Yellow
    $restoreScript = Join-Path $PSScriptRoot "Restore-Snapshot.ps1"
    if (-not (Test-Path $restoreScript)) {
        throw "Local restore script not found at $restoreScript"
    }
    
    # Run local restore script
    & $restoreScript -Project $ProjectName -SnapshotName $SnapshotName -SourcePath $localRepo -Force -SkipPreBackup
    Write-Host "[PRE-DEPLOYMENT] Local restore of snapshot complete. Commencing Git deployment." -ForegroundColor Green
}

# ----------------------------------------------------
# STEP 1: Local Staging & Commit
# ----------------------------------------------------
$stepTotal = if ($GitOnly) { "2" } else { "5" }
Write-Host "`n>>> [STEP 1/${stepTotal}] Staging and committing changes..." -ForegroundColor Cyan
Write-Host "[PROGRESS] 10% (Checking repository status...)"

# Helper function to read compose env variables
function Read-ComposeEnv {
    param([string]$ProjPath)

    $envFile = @(
        (Join-Path $ProjPath ".env.local"),
        (Join-Path $ProjPath ".env")
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1

    if (-not $envFile) { return @{} }

    $vars = @{}
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -eq '' -or $line.StartsWith('#')) { return }
        if ($line -match '^([^=]+)=(.*)$') {
            $vars[$matches[1].Trim()] = $matches[2].Trim().Trim('"').Trim("'")
        }
    }
    return $vars
}

function Read-ProductionComposeEnv {
    param([string]$ProjPath)

    $envFile = @(
        (Join-Path $ProjPath "deploy\production\.env"),
        (Join-Path $ProjPath "deploy\production\.env.production.example")
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1

    if (-not $envFile) { return @{} }

    $vars = @{}
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -eq '' -or $line.StartsWith('#')) { return }
        if ($line -match '^([^=]+)=(.*)$') {
            $vars[$matches[1].Trim()] = $matches[2].Trim().Trim('"').Trim("'")
        }
    }
    return $vars
}

function ConvertTo-GitPath {
    param([string]$PathValue)
    return (($PathValue -replace '\\', '/') -replace '^"\s*', '').Trim('"').Trim()
}

function Test-ProtectedDeployPath {
    param([string]$GitPath)

    $p = (ConvertTo-GitPath $GitPath).ToLowerInvariant()
    if (-not $p) { return $false }

    $allowed = @(
        '.env.example',
        '.env.local.example',
        'deploy/production/.env.production.example'
    )
    if ($allowed -contains $p) { return $false }

    if ($p -match '(^|/)\.local(/|$)') { return $true }
    if ($p -match '(^|/)secrets(/|$)') { return $true }
    if ($p -match '(^|/)\.env($|\.|/)') { return $true }
    if ($p -match '(^|/)wp-config(\.[^/]*)?\.php$') { return $true }
    if ($p -match '(^|/)[^/]*\.sql(\.gz)?$') { return $true }
    if ($p -match '(^|/)(snapshots|\.snapshots)(/|$)') { return $true }
    if ($p -match '^wordpress/wp-content/(uploads|cache|upgrade)(/|$)') { return $true }
    if ($p -eq 'wordpress/wp-content/debug.log') { return $true }
    if ($p -match '(^|/)tools/.*\.exe(\..*)?$') { return $true }

    return $false
}

function Get-GitStatusEntries {
    param([string]$RepoPath)

    $entries = @()
    $lines = @(git -C $RepoPath status --porcelain --untracked-files=all)
    foreach ($line in $lines) {
        if (-not $line -or $line.Length -lt 4) { continue }
        $status = $line.Substring(0, 2)
        $pathPart = $line.Substring(3).Trim()
        if ($pathPart -match ' -> ') {
            $parts = $pathPart -split ' -> ', 2
            $entries += [pscustomobject]@{ Status = $status; Path = (ConvertTo-GitPath $parts[0]) }
            $entries += [pscustomobject]@{ Status = $status; Path = (ConvertTo-GitPath $parts[1]) }
            continue
        }
        $entries += [pscustomobject]@{ Status = $status; Path = (ConvertTo-GitPath $pathPart) }
    }
    return $entries
}

function Unstage-GitPaths {
    param(
        [string]$RepoPath,
        [string[]]$Paths
    )

    foreach ($pathValue in @($Paths | Where-Object { $_ } | Select-Object -Unique)) {
        git -C $RepoPath restore --staged -- $pathValue 2>$null | Out-Null
    }
}

function Get-MypoolsPluginVersionFromText {
    param([string]$Content)

    $header = $null
    $define = $null
    if ($Content -match '(?m)^\s*\*\s*Version:\s*([0-9A-Za-z\.\-\+]+)\s*$') {
        $header = $Matches[1]
    }
    if ($Content -match "define\(\s*'MYPOOLS_CORE_VERSION'\s*,\s*'([^']+)'\s*\)") {
        $define = $Matches[1]
    }

    return [pscustomobject]@{
        Header = $header
        Define = $define
    }
}

function Test-MypoolsAssetSensitivePath {
    param([string]$GitPath)

    $p = (ConvertTo-GitPath $GitPath).ToLowerInvariant()
    $prefix = 'wordpress/wp-content/plugins/mypools-core/'

    if ($p -in @(
        'service-worker.js',
        'wordpress/service-worker.js',
        'wordpress/manifest.json',
        'wordpress/offline.html'
    )) { return $true }
    if ($p.StartsWith('wordpress/icons/')) { return $true }

    if (-not $p.StartsWith($prefix)) { return $false }

    if ($p -match '\.(css|js)$') { return $true }
    if ($p.StartsWith($prefix + 'modules/ui/assets/')) { return $true }
    if ($p -in @(
        $prefix + 'mypools-core.php',
        $prefix + 'modules/ui/assets.php',
        $prefix + 'modules/ui/button-assets.php',
        $prefix + 'modules/ui/admin-ux.php'
    )) { return $true }

    return $false
}

function Assert-MypoolsVersionBumpForAssetChanges {
    param([string]$RepoPath)

    $corePath = 'wordpress/wp-content/plugins/mypools-core/mypools-core.php'
    if (-not (Test-Path (Join-Path $RepoPath $corePath))) { return }

    $stagedFiles = @(git -C $RepoPath diff --cached --name-only)
    $assetFiles = @($stagedFiles | Where-Object { Test-MypoolsAssetSensitivePath $_ })
    if ($assetFiles.Count -eq 0) { return }

    if ($stagedFiles -notcontains $corePath) {
        throw "MyPools asset changes require a cache-busting version bump. Update Version: and MYPOOLS_CORE_VERSION in $corePath before deploying. Asset changes: $($assetFiles -join ', ')"
    }

    $indexedContent = (git -C $RepoPath show ":$corePath" 2>$null) -join "`n"
    $headContent = (git -C $RepoPath show "HEAD:$corePath" 2>$null) -join "`n"
    $indexedVersion = Get-MypoolsPluginVersionFromText $indexedContent
    $headVersion = Get-MypoolsPluginVersionFromText $headContent

    if (-not $indexedVersion.Header -or -not $indexedVersion.Define) {
        throw "Could not read Version: and MYPOOLS_CORE_VERSION from staged $corePath."
    }
    if ($indexedVersion.Header -ne $indexedVersion.Define) {
        throw "MyPools version mismatch in staged $corePath. Version: is $($indexedVersion.Header), MYPOOLS_CORE_VERSION is $($indexedVersion.Define)."
    }
    if ($headVersion.Header -and $indexedVersion.Header -eq $headVersion.Header) {
        throw "MyPools asset changes are staged, but MYPOOLS_CORE_VERSION was not bumped from $($headVersion.Header)."
    }

    Write-Host "MyPools asset version bump verified: $($headVersion.Header) -> $($indexedVersion.Header)" -ForegroundColor Green
}

# Guarantee database.sql never appears in git — remove from index if somehow staged
git -C $localRepo rm --cached database.sql 2>$null | Out-Null
$localDumpFile = Join-Path $localRepo "database.sql"
if (Test-Path $localDumpFile) { Remove-Item $localDumpFile -Force -ErrorAction SilentlyContinue }

# Guarantee snapshot archives never appear in git — remove from index if somehow tracked
git -C $localRepo rm --cached Snapshots/*/project.zip 2>$null | Out-Null
git -C $localRepo rm --cached Snapshots/*/database.sql 2>$null | Out-Null
git -C $localRepo rm --cached .snapshots/*/project.zip 2>$null | Out-Null
git -C $localRepo rm --cached .snapshots/*/database.sql 2>$null | Out-Null

$gitEntries = @(Get-GitStatusEntries -RepoPath $localRepo)
$protectedEntries = @($gitEntries | Where-Object { Test-ProtectedDeployPath $_.Path })
$safeEntries = @($gitEntries | Where-Object { -not (Test-ProtectedDeployPath $_.Path) })

if ($protectedEntries.Count -gt 0) {
    $protectedPaths = @($protectedEntries | ForEach-Object { $_.Path } | Select-Object -Unique)
    Unstage-GitPaths -RepoPath $localRepo -Paths $protectedPaths
    Write-Host "Protected local files were skipped and will not be committed:" -ForegroundColor Yellow
    $protectedPaths | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
}

if ($safeEntries.Count -eq 0) {
    if ($protectedEntries.Count -gt 0) {
        Write-Host "No deployable changes to commit; protected local changes remain uncommitted." -ForegroundColor Yellow
    } else {
        Write-Host "Working tree clean. Nothing to commit locally." -ForegroundColor Yellow
    }
} else {
    Write-Host "Staging deployable modified and untracked files..." -ForegroundColor White
    $safePaths = @($safeEntries | ForEach-Object { $_.Path } | Select-Object -Unique)
    foreach ($pathValue in $safePaths) {
        git -C $localRepo add -- $pathValue
        if ($LASTEXITCODE -ne 0) { throw "git add failed for $pathValue" }
    }

    $stagedProtected = @(git -C $localRepo diff --cached --name-only | Where-Object { Test-ProtectedDeployPath $_ })
    if ($stagedProtected.Count -gt 0) {
        Unstage-GitPaths -RepoPath $localRepo -Paths $stagedProtected
        throw "Deploy blocked: protected file(s) reached the staging area: $($stagedProtected -join ', ')"
    }

    Assert-MypoolsVersionBumpForAssetChanges -RepoPath $localRepo

    Write-Host "Committing changes..." -ForegroundColor White
    git -C $localRepo commit -m $CommitMessage
    if ($LASTEXITCODE -ne 0) { throw "git commit failed" }
    Write-Host "Changes committed successfully." -ForegroundColor Green
}

$localCommitHash = (git -C $localRepo rev-parse HEAD).Trim()
Write-Host "Target deployment commit: $localCommitHash" -ForegroundColor White

# ----------------------------------------------------
# STEP 2: Push to GitHub
# ----------------------------------------------------
$activeBranch = (git -C $localRepo branch --show-current).Trim()
if (-not $activeBranch) { $activeBranch = "main" }
Write-Host "`n>>> [STEP 2/${stepTotal}] Pushing to GitHub (origin/$activeBranch)..." -ForegroundColor Cyan
Write-Host "[PROGRESS] 20% (Pushing commits to remote...)"

# Run git push
$pushOutput = git -C $localRepo push origin $activeBranch 2>&1
$exitCode = $LASTEXITCODE
Write-Host $pushOutput -ForegroundColor DarkGray

if ($exitCode -ne 0) {
    if ($pushOutput -match "Already up to date") {
        Write-Host "GitHub remote is already up to date." -ForegroundColor Yellow
    } else {
        throw "git push failed with exit code $exitCode"
    }
} else {
    Write-Host "Successfully pushed to GitHub repository." -ForegroundColor Green
}

# If GitOnly mode, we're done after push
if ($GitOnly) {
    Write-Host "`n[PROGRESS] 100% (Git push completed successfully)"
    Write-Host "`n[Recovery State Completed...]" -ForegroundColor Green
    Write-Host "Git push to origin/$activeBranch completed. Commit: $localCommitHash" -ForegroundColor Green
    exit 0
}

# ----------------------------------------------------
# STEP 3: SCP database snapshot or contractor bundle to VPS
# ----------------------------------------------------
if ($ContractorSlug) {
    Write-Host "`n>>> [STEP 3/${stepTotal}] Contractor data transfer..." -ForegroundColor Cyan
} else {
    Write-Host "`n>>> [STEP 3/${stepTotal}] Database snapshot transfer..." -ForegroundColor Cyan
}

$script:ContractorSlugNormalized = $null
$script:ContractorBundleLocal = $null
if ($ContractorSlug) {
    $script:ContractorSlugNormalized = Normalize-ContractorSlug $ContractorSlug
    if (-not $script:ContractorSlugNormalized) {
        throw "Contractor slug is empty or invalid."
    }

    Write-Host "[PROGRESS] 30% (Exporting contractor '$($script:ContractorSlugNormalized)' from local WordPress...)" -ForegroundColor White

    if (-not (Get-Command podman -ErrorAction SilentlyContinue)) {
        throw "Contractor sync aborted: podman not in PATH."
    }

    $envVars = Read-ComposeEnv -ProjPath $localRepo
    $composeProject = if ($envVars['COMPOSE_PROJECT_NAME']) { $envVars['COMPOSE_PROJECT_NAME'] } else { "$($ProjectName.ToLower())-local" }
    $phpPod = Get-ComposePhpContainer -ComposeProject $composeProject -Label "Local"

    $syncScript = Join-Path $localRepo "scripts\sync-contractor-data.php"
    if (-not (Test-Path $syncScript)) {
        throw "Missing contractor sync script at $syncScript"
    }

    $wpSyncScript = Join-Path $localRepo "wordpress\sync-contractor-data.php"
    Copy-Item $syncScript $wpSyncScript -Force

    $exportOutput = & podman exec $phpPod php /var/www/html/sync-contractor-data.php export $script:ContractorSlugNormalized 2>&1
    Remove-Item $wpSyncScript -Force -ErrorAction SilentlyContinue

    $exportText = ($exportOutput -join "`n").Trim()
    if ($exportText -notmatch '"version"\s*:\s*1' -or $exportText -match '^\s*FAIL:') {
        throw "Contractor export failed for '$($script:ContractorSlugNormalized)': $exportText"
    }

    $tempJson = [System.IO.Path]::GetTempFileName() -replace '\.tmp$', '.json'
    [System.IO.File]::WriteAllText($tempJson, $exportText, [System.Text.UTF8Encoding]::new($false))
    $script:ContractorBundleLocal = $tempJson

    if (-not (Test-Path $tempJson) -or (Get-Item $tempJson).Length -lt 32) {
        Remove-Item $tempJson -Force -ErrorAction SilentlyContinue
        $script:ContractorBundleLocal = $null
        throw "Contractor export produced an empty bundle."
    }

    Sync-ContractorUploadFiles -BundleJsonPath $tempJson -ProjPath $localRepo

    Write-Host "[PROGRESS] 35% (Uploading contractor bundle to VPS via SCP...)" -ForegroundColor White
    Write-Host "SCP: $tempJson → ${user}@${hostIp}:${vpsInstallRoot}/contractor-sync.json" -ForegroundColor White
    & $plink -ssh "${user}@${hostIp}" -batch -hostkey $hostKey -pw $pw "rm -f ${vpsInstallRoot}/database.sql ${vpsInstallRoot}/contractor-sync.json" 2>$null | Out-Null
    & $pscp -pw $pw -hostkey $hostKey -q -batch $tempJson "${user}@${hostIp}:${vpsInstallRoot}/contractor-sync.json"
    $scpExit = $LASTEXITCODE

    if ($scpExit -ne 0) {
        Remove-Item $tempJson -Force -ErrorAction SilentlyContinue
        $script:ContractorBundleLocal = $null
        throw "Contractor bundle SCP failed with exit code $scpExit."
    }
    Write-Host "Contractor bundle uploaded. It will be imported on the VPS after code deploy." -ForegroundColor Green
}
elseif ($OverwriteDatabase) {
    Write-Host "[PROGRESS] 30% (Preparing database snapshot...)"

    $dbDumpFile = $null
    $tempDumpCreated = $false

    if ($SnapshotName) {
        $snapshotDump = Join-Path $snapshotDir "database.sql"
        if (Test-Path $snapshotDump) {
            $dbDumpFile = $snapshotDump
            Write-Host "Using pre-packaged snapshot database dump: $dbDumpFile" -ForegroundColor Green
        } else {
            Write-Warning "Snapshot database dump not found at $snapshotDump. Falling back to local database dump."
        }
    }

    if (-not $dbDumpFile) {
        Write-Host "[PROGRESS] 30% (Dumping local database...)"
        $envVars    = Read-ComposeEnv -ProjPath $localRepo
        $dbName     = if ($envVars['MYSQL_DATABASE'])      { $envVars['MYSQL_DATABASE'] }      else { $ProjectName.ToLower() }
        $dbPass     = if ($envVars['MYSQL_ROOT_PASSWORD']) { $envVars['MYSQL_ROOT_PASSWORD'] } elseif ($envVars['MYSQL_PASSWORD']) { $envVars['MYSQL_PASSWORD'] } else { "" }
        $composeProject = if ($envVars['COMPOSE_PROJECT_NAME']) { $envVars['COMPOSE_PROJECT_NAME'] } else { "$($ProjectName.ToLower())-local" }

        if (-not $dbPass) {
            Write-Warning "Database credentials not found in .env / .env.local. Cannot perform snapshot deploy."
            throw "Snapshot deploy aborted: no DB credentials."
        }

        if (-not (Get-Command podman -ErrorAction SilentlyContinue)) {
            throw "Snapshot deploy aborted: podman not in PATH."
        }

        $mysqlPod = @(podman ps --filter "label=io.podman.compose.project=$composeProject" --format "{{.Names}}" | Where-Object { $_ -match "mysql" } | Select-Object -First 1)
        if (-not $mysqlPod) {
            throw "Snapshot deploy aborted: local MySQL container ($composeProject) not running."
        }

        # Probe which dump binary is available
        $prevError = $ErrorActionPreference; $ErrorActionPreference = "Continue"
        podman exec $mysqlPod mariadb-dump --version 2>$null | Out-Null; $mariadbExit = $LASTEXITCODE
        podman exec $mysqlPod mysqldump    --version 2>$null | Out-Null; $mysqldExit  = $LASTEXITCODE
        $ErrorActionPreference = $prevError

        $dumpCmd = if ($mariadbExit -eq 0) { "mariadb-dump" } elseif ($mysqldExit -eq 0) { "mysqldump" } else { $null }
        if (-not $dumpCmd) { throw "Snapshot deploy aborted: no dump binary found in container." }

        # Dump to a temp file outside the git repo (never tracked)
        $tempDump = [System.IO.Path]::GetTempFileName() -replace '\.tmp$', '.sql'
        Write-Host "Dumping $dbName → $tempDump ..." -ForegroundColor White
        podman exec $mysqlPod $dumpCmd -uroot -p"$dbPass" --single-transaction --quick --lock-tables=false $dbName 2>$null |`
            Out-File -FilePath $tempDump -Encoding UTF8 -ErrorAction Stop

        if (-not (Test-Path $tempDump) -or (Get-Item $tempDump).Length -lt 1024) {
            Remove-Item $tempDump -Force -ErrorAction SilentlyContinue
            throw "Snapshot deploy aborted: dump file empty or missing."
        }
        Write-Host "Dump complete: $([math]::Round((Get-Item $tempDump).Length / 1MB, 2)) MB" -ForegroundColor Green

        # Strip UTF-8 BOM that PowerShell Out-File adds (Linux mariadb won't accept it)
        Write-Host "Stripping UTF-8 BOM if present..." -ForegroundColor White
        $rawBytes = [System.IO.File]::ReadAllBytes($tempDump)
        if ($rawBytes[0] -eq 0xEF -and $rawBytes[1] -eq 0xBB -and $rawBytes[2] -eq 0xBF) {
            [System.IO.File]::WriteAllBytes($tempDump, $rawBytes[3..($rawBytes.Length - 1)])
            Write-Host "BOM stripped." -ForegroundColor DarkGray
        }
        
        $dbDumpFile = $tempDump
        $tempDumpCreated = $true
    }

    # SCP the dump directly to the VPS — never touches git
    Write-Host "[PROGRESS] 35% (Uploading snapshot to VPS via SCP...)"
    Write-Host "SCP: $dbDumpFile → ${user}@${hostIp}:${vpsInstallRoot}/database.sql" -ForegroundColor White
    & $pscp -pw $pw -hostkey $hostKey -q -batch $dbDumpFile "${user}@${hostIp}:${vpsInstallRoot}/database.sql"
    $scpExit = $LASTEXITCODE

    # Always remove local temp dump regardless of SCP outcome
    if ($tempDumpCreated) {
        Remove-Item $dbDumpFile -Force -ErrorAction SilentlyContinue
    }

    if ($scpExit -ne 0) {
        throw "SCP upload failed with exit code $scpExit. Check SSH credentials and VPS connectivity."
    }
    Write-Host "Snapshot uploaded to VPS successfully. It will be restored and destroyed by the deploy script." -ForegroundColor Green
} else {
    Write-Host "Normal deploy - ensuring no stale database snapshot exists on VPS..." -ForegroundColor Cyan
    & $plink -ssh "${user}@${hostIp}" -batch -hostkey $hostKey -pw $pw "rm -f ${vpsInstallRoot}/database.sql ${vpsInstallRoot}/contractor-sync.json" 2>$null
    Write-Host "[PROGRESS] 35% (VPS state verified - code-only deploy)"
}

# ----------------------------------------------------
# STEP 4/5: Deploy to production VPS and verify sync
# ----------------------------------------------------
Write-Host "`n>>> [STEP 4/${stepTotal}] Deploying to production VPS..." -ForegroundColor Cyan

function Get-VpsDeployedCommit {
    param([string]$PreferStatusFile = $true)

    if ($PreferStatusFile) {
        $remoteCmd = "cat $vpsInstallRoot/deploy-status.json 2>/dev/null"
        $statusJson = (& $plink -ssh "${user}@${hostIp}" -batch -hostkey $hostKey -pw $pw $remoteCmd 2>$null)
        if ($LASTEXITCODE -eq 0 -and $statusJson) {
            try {
                $statusObj = $statusJson | ConvertFrom-Json
                if ($statusObj.commit) {
                    return $statusObj.commit.Trim()
                }
            } catch {}
        }
    }

    $remoteCmdFallback = "git -C $vpsInstallRoot rev-parse HEAD 2>/dev/null"
    $remoteCommitFallback = (& $plink -ssh "${user}@${hostIp}" -batch -hostkey $hostKey -pw $pw $remoteCmdFallback 2>$null)
    if ($LASTEXITCODE -eq 0 -and $remoteCommitFallback) {
        return $remoteCommitFallback.Trim()
    }
    return $null
}

function Test-VpsCommitSynced {
  param([string]$ExpectedCommit)

  $remoteCommit = Get-VpsDeployedCommit
  if ($remoteCommit) {
    Write-Host "VPS Last Deployed Commit: $remoteCommit" -ForegroundColor DarkGray
  }
  return ($remoteCommit -and ($remoteCommit -eq $ExpectedCommit))
}

$vpsSynced = $false
$forceProductionDeploy = $OverwriteDatabase.IsPresent -or [bool]$ContractorSlug

if ($forceProductionDeploy) {
    if ($OverwriteDatabase) {
        Write-Host "Database overwrite requested - production deploy will run even if commit already matches." -ForegroundColor Yellow
    } elseif ($ContractorSlug) {
        Write-Host "Contractor sync requested - production deploy will run even if commit already matches." -ForegroundColor Yellow
    }
}

# Brief grace period in case GitHub Actions already deployed this push
Write-Host "Checking whether GitHub Actions has already deployed commit $localCommitHash..." -ForegroundColor Yellow
if (-not $forceProductionDeploy) {
for ($grace = 1; $grace -le 12; $grace++) {
    Write-Host "[PROGRESS] $([math]::Min(30 + $grace, 40))% (Waiting for GitHub Actions... Attempt $grace/12)"
    if (Test-VpsCommitSynced -ExpectedCommit $localCommitHash) {
        Write-Host "SUCCESS: VPS already matches target commit $localCommitHash" -ForegroundColor Green
        $vpsSynced = $true
        break
    }
    Start-Sleep -Seconds 10
}
}

if (-not $vpsSynced) {
    Write-Host "GitHub Actions has not updated production - running deploy-production.sh on VPS via SSH..." -ForegroundColor Yellow
    Write-Host "[PROGRESS] 40% (Running production deploy script on VPS...)"

    # Force-sync git before deploy (handles manual VPS hotfixes and older deploy scripts without checkout -f).
    $gitForceSync = "cd $vpsInstallRoot && git fetch origin $activeBranch && git checkout -f -B $activeBranch origin/$activeBranch && git reset --hard origin/$activeBranch"
    $syncOutput = & $plink -ssh "${user}@${hostIp}" -batch -hostkey $hostKey -pw $pw $gitForceSync 2>&1
    if ($syncOutput) { Write-Host $syncOutput -ForegroundColor DarkGray }
    if ($LASTEXITCODE -ne 0) {
        throw "VPS git force-sync failed with exit code $LASTEXITCODE. Resolve conflicts on the server clone manually."
    }

    $deployCmd = "export MYSPOOLS_INSTALL_ROOT=$vpsInstallRoot; export MYSPOOLS_DEPLOY_BRANCH=$activeBranch; bash $vpsInstallRoot/scripts/deploy-production.sh"
    $deployOutput = & $plink -ssh "${user}@${hostIp}" -batch -hostkey $hostKey -pw $pw $deployCmd 2>&1
    Write-Host $deployOutput -ForegroundColor DarkGray
    if ($LASTEXITCODE -ne 0) {
        throw "Production deploy script failed on VPS with exit code $LASTEXITCODE. Review the log output above."
    }

    if ($OverwriteDatabase.IsPresent) {
        Write-Host "Verifying production URL migration after database import..." -ForegroundColor Cyan
        $prodEnv = Read-ProductionComposeEnv -ProjPath $localRepo
        $phpProject = if ($prodEnv['COMPOSE_PROJECT_NAME']) { $prodEnv['COMPOSE_PROJECT_NAME'] } else { "$($ProjectName.ToLower())-pod" }
        $urlFixCmd = "podman exec ${phpProject}_redis_1 redis-cli FLUSHALL >/dev/null 2>&1 || true; cp $vpsInstallRoot/scripts/update-wp-urls.php $vpsInstallRoot/wordpress/update-wp-urls.php && podman exec ${phpProject}_php_1 php /var/www/html/update-wp-urls.php; ec=`$?; rm -f $vpsInstallRoot/wordpress/update-wp-urls.php; exit `$ec"
        $urlOutput = & $plink -ssh "${user}@${hostIp}" -batch -hostkey $hostKey -pw $pw $urlFixCmd 2>&1
        if ($urlOutput) { Write-Host $urlOutput -ForegroundColor DarkGray }
        if ($LASTEXITCODE -ne 0) {
            throw "Production URL migration failed after database import. Media library and galleries require siteurl https://mypools.co.za in the database."
        }
        Write-Host "Production URLs verified." -ForegroundColor Green
    }

    if (Test-VpsCommitSynced -ExpectedCommit $localCommitHash) {
        Write-Host "SUCCESS: VPS deployed and synchronized to target commit $localCommitHash" -ForegroundColor Green
        $vpsSynced = $true
    }
}

if (-not $vpsSynced) {
    Write-Host "Polling VPS for deploy-status.json confirmation..." -ForegroundColor Yellow
    $maxAttempts = 30
    $attempt = 1
    while ($attempt -le $maxAttempts) {
        Write-Host "[PROGRESS] $([math]::Min(40 + $attempt, 75))% (Confirming VPS commit... Attempt $attempt/$maxAttempts)"
        if (Test-VpsCommitSynced -ExpectedCommit $localCommitHash) {
            Write-Host "SUCCESS: VPS code has fully deployed and synchronized to target commit $localCommitHash" -ForegroundColor Green
            $vpsSynced = $true
            break
        }
        Start-Sleep -Seconds 10
        $attempt++
    }
}

if (-not $vpsSynced) {
    throw "Production deploy did not reach commit $localCommitHash. Check GitHub Actions (if used) and VPS deploy logs."
}

if ($ContractorSlug -and $script:ContractorSlugNormalized) {
    Write-Host "`n>>> [STEP 4b/${stepTotal}] Contractor production sync..." -ForegroundColor Cyan
    Invoke-ContractorProductionImport
    if ($script:ContractorBundleLocal -and (Test-Path $script:ContractorBundleLocal)) {
        Remove-Item $script:ContractorBundleLocal -Force -ErrorAction SilentlyContinue
        $script:ContractorBundleLocal = $null
    }
}

# ----------------------------------------------------
# STEP 5/5: Health and Parity Check
# ----------------------------------------------------
Write-Host "`n>>> [STEP 5/${stepTotal}] Verifying production health and parity..." -ForegroundColor Cyan
Write-Host "[PROGRESS] 80% (Checking VPS container health...)"

$containers = @("mysql", "redis", "php", "nginx")
$allHealthy = $true

$envVars = Read-ProductionComposeEnv -ProjPath $localRepo
$remoteComposeProject = if ($envVars['COMPOSE_PROJECT_NAME']) { $envVars['COMPOSE_PROJECT_NAME'] } else { "$($ProjectName.ToLower())-pod" }
Write-Host "Fetching running containers status on VPS..." -ForegroundColor Cyan
$psCmd = "podman ps --filter 'label=io.podman.compose.project=$remoteComposeProject' --format '{{.Names}} ({{.Status}})'"
$containersState = & $plink -ssh "${user}@${hostIp}" -batch -hostkey $hostKey -pw $pw $psCmd
Write-Host $containersState -ForegroundColor White

foreach ($svc in $containers) {
    $matched = $containersState | Where-Object { $_ -match $svc }
    if ($matched) {
        if ($matched -match "Up|healthy|running") {
            Write-Host "Service '$svc' is Running/Healthy on VPS." -ForegroundColor Green
        } else {
            Write-Host "Service '$svc' is in state: $matched" -ForegroundColor Red
            $allHealthy = $false
        }
    } else {
        Write-Host "Service '$svc' container NOT FOUND on VPS." -ForegroundColor Red
        $allHealthy = $false
    }
}

# Verify HTTPS Smoke Checks
Write-Host "`nChecking public HTTPS website endpoints..." -ForegroundColor Cyan
Write-Host "[PROGRESS] 90% (Testing web connectivity...)"

$siteUrlClean = $siteUrl.TrimEnd('/')
$testUrls = @("$siteUrlClean/")
if ($ProjectName -eq "MyPools" -or $ProjectName -eq "mypools") {
    $testUrls += "$siteUrlClean/contractors"
}

foreach ($url in $testUrls) {
    Write-Host "Testing $url ... " -NoNewline
    $httpCode = 0
    try {
        # Check HTTP response code with curl
        $resp = curl.exe -s -o NUL -w "%{http_code}" --max-time 15 -L $url
        $httpCode = [int]$resp
    } catch {
        Write-Host "Request Failed: $_" -ForegroundColor Red
        $allHealthy = $false
        continue
    }
    
    if ($httpCode -eq 200 -or $httpCode -eq 301 -or $httpCode -eq 302) {
        Write-Host "HTTP Status: $httpCode (OK)" -ForegroundColor Green
    } else {
        Write-Host "HTTP Status: $httpCode (FAILED)" -ForegroundColor Red
        $allHealthy = $false
    }
}

# Smoke test verification of assets (CSS and images)
Write-Host "`nSmoke testing page body for port mismatches (e.g. 9080/9082 leak)..." -ForegroundColor Cyan
try {
    $siteUrlClean = $siteUrl.TrimEnd('/')
    $pageHtml = curl.exe -s -L --max-time 15 "$siteUrlClean/"
    if ($pageHtml -match ":9080" -or $pageHtml -match ":9082") {
        Write-Host "WARNING: Detected port leak in home page HTML (references to 9080 or 9082 found)!" -ForegroundColor Red
        $allHealthy = $false
    } else {
        Write-Host "Home page asset hosts: OK (No internal port leakage detected)." -ForegroundColor Green
    }
    
    if ($ProjectName -eq "MyPools" -or $ProjectName -eq "mypools") {
        $coreFile = Join-Path $localRepo "wordpress\wp-content\plugins\mypools-core\mypools-core.php"
        if (Test-Path $coreFile) {
            $localCoreVersion = (Get-MypoolsPluginVersionFromText (Get-Content -Raw $coreFile)).Define
            $liveCoreVersion = $null
            if ($pageHtml -match 'mypools-core\.css\?ver=([^''"\s<]+)') {
                $liveCoreVersion = $Matches[1]
            } elseif ($pageHtml -match 'mypools-core\.js\?ver=([^''"\s<]+)') {
                $liveCoreVersion = $Matches[1]
            }

            if ($localCoreVersion -and $liveCoreVersion -and $localCoreVersion -eq $liveCoreVersion) {
                Write-Host "MyPools live asset version: OK (?ver=$liveCoreVersion)" -ForegroundColor Green
            } elseif ($localCoreVersion) {
                $liveVersionText = if ($liveCoreVersion) { $liveCoreVersion } else { 'none' }
                Write-Host "WARNING: MyPools live asset version mismatch. Expected ?ver=$localCoreVersion but saw $liveVersionText." -ForegroundColor Red
                $allHealthy = $false
            }
        }

        $contractorsHtml = curl.exe -s -L --max-time 15 "$siteUrlClean/contractors"
        if ($contractorsHtml -match ":9080" -or $contractorsHtml -match ":9082") {
            Write-Host "WARNING: Detected port leak in contractors page HTML!" -ForegroundColor Red
            $allHealthy = $false
        } else {
            Write-Host "Contractors page asset hosts: OK (No internal port leakage detected)." -ForegroundColor Green
        }
    }
} catch {
    Write-Host "Warning: Failed to fetch HTML body check." -ForegroundColor Yellow
}

Write-Host "[PROGRESS] 100% (Parity & health verification completed)"

if ($allHealthy) {
    Write-Host "`n[Recovery State Completed...]" -ForegroundColor Green
    Write-Host "Production deployment is fully operational, verified, and has parity." -ForegroundColor Green
} else {
    Write-Warning "`n[Recovery State Completed with warnings...]"
    Write-Host "Health or parity check failed/warned. Please inspect logs manually." -ForegroundColor Red
}
