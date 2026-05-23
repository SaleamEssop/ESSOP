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
    [Parameter(Mandatory = $true)]
    [string]$SnapshotName,
    [string]$CommitMessage = "Deploy from Snapshot Recovery Panel",
    [switch]$OverwriteDatabase
)

$ErrorActionPreference = "Continue"
$localRepo = (Resolve-Path $SourcePath).Path
$ProjectName = Split-Path -Leaf $localRepo

# Resolve Tools
function Get-ToolPath {
    param([string]$ToolName)
    $projTools = Join-Path $localRepo "tools\$ToolName"
    if (Test-Path $projTools) { return $projTools }
    $globalTools = "C:\snapshots\tools\$ToolName"
    if (Test-Path $globalTools) { return $globalTools }
    $cmd = Get-Command $ToolName -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $scriptDirTool = Join-Path "C:\snapshots" "tools\$ToolName"
    if (Test-Path $scriptDirTool) { return $scriptDirTool }
    return $ToolName # Fallback to path execution
}

$plink = Get-ToolPath "plink.exe"
$pscp  = Get-ToolPath "pscp.exe"

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

$vpsInstallRoot = if ($settings -and $settings.vpsInstallRoot) { $settings.vpsInstallRoot }
                  else { "/opt/$($ProjectName.ToLower())" }

$siteUrl = if ($settings -and $settings.siteUrl) { $settings.siteUrl }
           else { "https://$($ProjectName.ToLower()).co.za" }

Write-Host "=== Git Deployment & Production Verification Pipeline ==="  -ForegroundColor Cyan
Write-Host "Local Repository : $localRepo"                               -ForegroundColor White
Write-Host "Target VPS       : ${user}@${hostIp}"                        -ForegroundColor White
Write-Host "Commit Message   : $CommitMessage"                           -ForegroundColor White
Write-Host "Snapshot Deploy  : $($OverwriteDatabase.IsPresent)"          -ForegroundColor White
if ($SnapshotName) {
Write-Host "Source Snapshot   : $SnapshotName"                            -ForegroundColor White
}

# ----------------------------------------------------
# PRE-DEPLOYMENT: Local Restore of Selected Snapshot
# ----------------------------------------------------
if ($SnapshotName) {
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
    $restoreScript = "C:\snapshots\Restore-Snapshot.ps1"
    if (-not (Test-Path $restoreScript)) {
        throw "Local restore script not found at $restoreScript"
    }
    
    # Run local restore script
    & $restoreScript -Project $ProjectName -SnapshotName $SnapshotName -SourcePath $localRepo -Force -SkipPreBackup
    Write-Host "[PRE-DEPLOYMENT] Local restore of snapshot complete. Commencing Git deployment." -ForegroundColor Green
}

# ----------------------------------------------------
# STEP 1/5: Local Staging & Commit (code only — no DB in git)
# ----------------------------------------------------
Write-Host "`n>>> [STEP 1/5] Staging and committing changes..." -ForegroundColor Cyan
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

# Guarantee database.sql never appears in git — remove from index if somehow staged
git -C $localRepo rm --cached database.sql 2>$null | Out-Null
$localDumpFile = Join-Path $localRepo "database.sql"
if (Test-Path $localDumpFile) { Remove-Item $localDumpFile -Force -ErrorAction SilentlyContinue }

$gitStatus = (git -C $localRepo status --porcelain)
if (-not $gitStatus) {
    Write-Host "Working tree clean. Nothing to commit locally." -ForegroundColor Yellow
} else {
    Write-Host "Staging modified and untracked files..." -ForegroundColor White
    git -C $localRepo add -A
    if ($LASTEXITCODE -ne 0) { throw "git add failed" }

    Write-Host "Committing changes..." -ForegroundColor White
    git -C $localRepo commit -m $CommitMessage
    if ($LASTEXITCODE -ne 0) { throw "git commit failed" }
    Write-Host "Changes committed successfully." -ForegroundColor Green
}

$localCommitHash = (git -C $localRepo rev-parse HEAD).Trim()
Write-Host "Target deployment commit: $localCommitHash" -ForegroundColor White

# ----------------------------------------------------
# STEP 2/5: Push to GitHub
# ----------------------------------------------------
$activeBranch = (git -C $localRepo branch --show-current).Trim()
if (-not $activeBranch) { $activeBranch = "main" }
Write-Host "`n>>> [STEP 2/5] Pushing to GitHub (origin/$activeBranch)..." -ForegroundColor Cyan
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

# ----------------------------------------------------
# STEP 3/5: SCP snapshot directly to VPS (Snapshot Deploy only)
# ----------------------------------------------------
Write-Host "`n>>> [STEP 3/5] Database snapshot transfer..." -ForegroundColor Cyan

if ($OverwriteDatabase) {
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
    Write-Host "Normal deploy - ensuring no stale database.sql exists on VPS..." -ForegroundColor Cyan
    # Remove any leftover snapshot from a previous aborted snapshot deploy
    & $plink -ssh "${user}@${hostIp}" -batch -hostkey $hostKey -pw $pw "rm -f ${vpsInstallRoot}/database.sql" 2>$null
    Write-Host "[PROGRESS] 35% (VPS state verified - code-only deploy)"
}

# ----------------------------------------------------
# STEP 4/5: Monitor CI/CD synchronization on VPS
# ----------------------------------------------------
Write-Host "`n>>> [STEP 4/5] Monitoring GitHub Actions CI/CD on VPS..." -ForegroundColor Cyan
Write-Host "Polling VPS to confirm deploy-status.json matches target commit..." -ForegroundColor Yellow

$vpsSynced = $false
$maxAttempts = 90 # 15 minutes max polling (90 * 10 seconds)
$attempt = 1

while ($attempt -le $maxAttempts) {
    Write-Host "[PROGRESS] $([math]::Min(30 + $attempt, 75))% (Polling VPS commit... Attempt $attempt/$maxAttempts)"
    
    try {
        # Check remote deploy status JSON file
        $remoteCmd = "cat $vpsInstallRoot/deploy-status.json 2>/dev/null"
        $statusJson = (& $plink -ssh "${user}@${hostIp}" -batch -hostkey $hostKey -pw $pw $remoteCmd 2>$null)
        
        if ($LASTEXITCODE -eq 0 -and $statusJson) {
            try {
                $statusObj = $statusJson | ConvertFrom-Json
                $remoteCommit = $statusObj.commit.Trim()
                Write-Host "VPS Last Deployed Commit: $remoteCommit" -ForegroundColor DarkGray
                
                if ($remoteCommit -eq $localCommitHash) {
                    Write-Host "SUCCESS: VPS code has fully deployed and synchronized to target commit $localCommitHash" -ForegroundColor Green
                    $vpsSynced = $true
                    break
                }
            } catch {
                Write-Host "Warning: Failed to parse deploy-status.json from VPS." -ForegroundColor Yellow
            }
        } else {
            # Fallback to checking the current git hash in case status file doesn't exist yet
            $remoteCmdFallback = "git -C $vpsInstallRoot log -1 --format=%H"
            $remoteCommitFallback = (& $plink -ssh "${user}@${hostIp}" -batch -hostkey $hostKey -pw $pw $remoteCmdFallback 2>$null).Trim()
            if ($LASTEXITCODE -eq 0) {
                Write-Host "VPS Git HEAD Commit (Status file missing or empty): $remoteCommitFallback" -ForegroundColor DarkGray
                if ($remoteCommitFallback -eq $localCommitHash) {
                    Write-Host "Commit matches, but waiting for deploy-status.json to confirm completion..." -ForegroundColor Yellow
                }
            } else {
                Write-Host "Warning: Failed to fetch commit hash or status from VPS (SSH connection or command error)." -ForegroundColor Yellow
            }
        }
    } catch {
        Write-Host "Warning: Exception raised while polling VPS: $_" -ForegroundColor Yellow
    }
    
    Start-Sleep -Seconds 10
    $attempt++
}

if (-not $vpsSynced) {
    throw "Timeout or failure waiting for VPS commit synchronization. Please check GitHub Actions logs."
}

# ----------------------------------------------------
# STEP 5/5: Health and Parity Check
# ----------------------------------------------------
Write-Host "`n>>> [STEP 5/5] Verifying production health and parity..." -ForegroundColor Cyan
Write-Host "[PROGRESS] 80% (Checking VPS container health...)"

$containers = @("mysql", "redis", "php", "nginx")
$allHealthy = $true

$envVars = Read-ComposeEnv -ProjPath $localRepo
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
