#Requires -Version 5.1
<#
.SYNOPSIS
  Creates a full recovery snapshot of a MyPools project — project files zip + database dump.
  Stored externally at C:\snapshots\<project>\ so it survives project deletion.
.DESCRIPTION
  Digital Ocean-style snapshots: complete restorable images stored outside the project.
  Powered-off snapshots (default) produce consistent database dumps. Live snapshots skip
  container stop/start but may produce inconsistent DB dumps.
.PARAMETER Project
  Project name (default: mypools). Used for snapshot subdirectory and compose project.
.PARAMETER Description
  Required. Human-readable description of this snapshot.
.PARAMETER SourcePath
  Path to project root. Default: derived from known project map.
.PARAMETER Live
  Skip stopping containers. DB dump may be inconsistent with file state.
.PARAMETER NoDatabase
  Skip database dump. Use when DB is not running or not needed.
.EXAMPLE
  .\Create-Snapshot.ps1 -Description "Before nginx refactor"
  .\Create-Snapshot.ps1 -Project mypools -Description "After DB import" -Live
#>

param(
    [string]$Project = "mypools",
    [Parameter(Mandatory = $true)]
    [string]$Description,
    [string]$SourcePath,
    [switch]$Live,
    [switch]$NoDatabase,
    [string]$BackupLevel = "High",
    [int]$RetentionCount = 5,
    [string]$ExcludePaths = ""
)

$ErrorActionPreference = "Stop"
$script:SnapshotsRoot = $PSScriptRoot

# ── Resolve project source path ────────────────────────────
function Get-ProjectSourcePath {
    param([string]$Proj)

    if ($SourcePath -and (Test-Path $SourcePath)) {
        return (Resolve-Path $SourcePath).Path
    }

    # Try loading from projects.json first
    $projectsJsonPath = Join-Path $PSScriptRoot "projects.json"
    if (Test-Path $projectsJsonPath) {
        try {
            $projs = Get-Content $projectsJsonPath -Raw | ConvertFrom-Json
            $found = $projs | Where-Object { $_.name -eq $Proj } | Select-Object -First 1
            if ($found -and $found.path -and (Test-Path $found.path)) {
                return (Resolve-Path $found.path).Path
            }
        } catch {
            Write-Warning "Failed to parse projects.json: $_"
        }
    }

    $known = @{
        "mypools"        = "C:\Podman\MyPools"
        "ESSOP"          = "C:\ESSOP"
        "mycities"       = "C:\Docker\projects\mycities"
        "deepseek-tunnel" = "C:\Podman\ngrok"
    }

    if ($known.ContainsKey($Proj)) {
        $p = $known[$Proj]
        if (Test-Path $p) { return (Resolve-Path $p).Path }
    }

    throw "Cannot resolve source path for project '$Proj'. Use -SourcePath to specify."
}

# ── Detect podman-compose provider ──────────────────────────
function Set-ComposeProvider {
    $pc = Get-Command podman-compose -ErrorAction SilentlyContinue
    if ($pc) {
        $env:PODMAN_COMPOSE_PROVIDER = $pc.Source
        return $true
    }
    Remove-Item Env:PODMAN_COMPOSE_PROVIDER -ErrorAction SilentlyContinue
    return $false
}

# ── Read compose env file ───────────────────────────────────
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

# ── Main ────────────────────────────────────────────────────
Write-Host "`n=== MyPools Snapshot - Create ===" -ForegroundColor Cyan

# Normalize BackupLevel to title case
$BackupLevel = (Get-Culture).TextInfo.ToTitleCase($BackupLevel.ToLower())
if ($BackupLevel -notIn @("High", "Medium", "Low")) {
    $BackupLevel = "High"
}

# LOW: selective framework-only DB dump (wp_options data + schema only for rest)
# Medium/High: full DB dump
$LowSelectiveDb = ($BackupLevel -eq "Low")
if ($LowSelectiveDb) {
    # Override NoDatabase — LOW includes a selective framework dump
    $NoDatabase = $false
}

$Source = Get-ProjectSourcePath -Proj $Project
Write-Host "Project: $Project" -ForegroundColor White
Write-Host "Source : $Source" -ForegroundColor White
Write-Host "Level  : $BackupLevel" -ForegroundColor Yellow

$envVars = Read-ComposeEnv -ProjPath $Source
$composeProject = if ($envVars['COMPOSE_PROJECT_NAME']) { $envVars['COMPOSE_PROJECT_NAME'] } else { "$Project-local" }
$composeFile = Join-Path $Source "compose.yml"
if (-not (Test-Path $composeFile)) { throw "compose.yml not found at $composeFile" }
$envFilePath = if (Test-Path (Join-Path $Source ".env.local")) { Join-Path $Source ".env.local" } else { Join-Path $Source ".env" }

$ProjectSnapshotsRoot = Join-Path $Source "Snapshots"
if (-not (Test-Path $ProjectSnapshotsRoot)) {
    New-Item -ItemType Directory -Path $ProjectSnapshotsRoot -Force | Out-Null
}

$timestamp = Get-Date -Format "yyyy-MM-dd-HHmm"
$snapshotDir = Join-Path $ProjectSnapshotsRoot $timestamp
if (Test-Path $snapshotDir) {
    Remove-Item -Path $snapshotDir -Recurse -Force -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Path $snapshotDir -Force | Out-Null
Write-Host "Snapshot: $snapshotDir" -ForegroundColor White

if (-not ($NoDatabase -and $Live)) {
    if (-not (Get-Command podman -ErrorAction SilentlyContinue)) {
        Write-Warning "podman not in PATH. Skipping database dump & container management."
        $NoDatabase = $true
        $Live = $true
        $containersRunning = $false
    } else {
        Set-ComposeProvider | Out-Null

        # Test if Podman engine is responding
        $null = podman ps --format "{{.Names}}" 2>$null
        $podmanOk = ($LASTEXITCODE -eq 0)

        if (-not $podmanOk) {
            Write-Warning "Podman is not responding. Attempting to restore Podman connection..."
            
            # 1. Kill any existing stuck podman CLI processes to release pipe/lock blocks
            Write-Host "  Terminating stuck podman CLI processes..." -ForegroundColor DarkGray
            Get-Process -Name "podman" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
            
            # 2. Check if WSL default machine is running
            $wslDistros = try { wsl -l -v 2>$null } catch { "" }
            $machineRunning = $false
            if ($wslDistros -match "podman-machine-default\s+Running") {
                $machineRunning = $true
            }
            
            if ($machineRunning) {
                Write-Host "  Podman machine is running but unresponsive. Performing WSL shutdown..." -ForegroundColor Yellow
                try {
                    wsl --shutdown 2>&1 | Out-Null
                    Start-Sleep -Seconds 3
                } catch {}
            }
            
            # 3. Start the podman machine
            Write-Host "  Starting Podman machine..." -ForegroundColor Cyan
            try {
                podman machine start 2>&1 | Out-Null
                Start-Sleep -Seconds 12
            } catch {
                Write-Warning "Failed to start podman machine: $_"
            }
            
            # 4. Re-test connection
            $null = podman ps --format "{{.Names}}" 2>$null
            $podmanOk = ($LASTEXITCODE -eq 0)
            
            if ($podmanOk) {
                Write-Host "Podman connection successfully recovered!" -ForegroundColor Green
            } else {
                Write-Warning "Could not restore Podman connection. Skipping database dump & container states."
                Write-Warning "Proceeding with file-only backup to ensure snapshot completes."
                $NoDatabase = $true
                $Live = $true
            }
        }

        # If podman is now responsive, retrieve containers list
        if ($podmanOk) {
            $containers = @(podman ps --filter "label=io.podman.compose.project=$composeProject" --format "{{.Names}}" 2>$null)
            $containersRunning = $containers.Count -gt 0
            if ($containersRunning) {
                Write-Host "Containers running: $($containers -join ', ')" -ForegroundColor Green
            } else {
                Write-Host "No containers running for $composeProject" -ForegroundColor Yellow
            }
        } else {
            $containersRunning = $false
        }
    }
} else {
    $containersRunning = $false
    Write-Host "Podman skipped (NoDatabase + Live mode)" -ForegroundColor DarkGray
}

# ── Step 1: Stop containers ─────────────────────────────────
$wasStopped = $false
if (-not $Live -and $containersRunning) {
    Write-Host "`nStopping containers for consistent snapshot..." -ForegroundColor Cyan
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    podman-compose --env-file $envFilePath -f $composeFile -p $composeProject down 2>&1 | Out-Null
    $ErrorActionPreference = $prev
    $wasStopped = $true
    Write-Host "Containers stopped." -ForegroundColor Green
}

# ── Step 2: Database dump ───────────────────────────────────
$dbDumped = $false
if (-not $NoDatabase) {
    Write-Host "`nDumping database..." -ForegroundColor Cyan

    $dbName = if ($envVars['MYSQL_DATABASE']) { $envVars['MYSQL_DATABASE'] } else { $Project }
    $dbPass = if ($envVars['MYSQL_ROOT_PASSWORD']) { $envVars['MYSQL_ROOT_PASSWORD'] } elseif ($envVars['MYSQL_PASSWORD']) { $envVars['MYSQL_PASSWORD'] } else { "" }

    if (-not $dbPass) {
        Write-Warning "No DB password found in env file. Skipping database dump."
    } else {
        # If containers were stopped, start just mysql for the dump
        if ($wasStopped) {
            Write-Host "  Starting MySQL temporarily for dump..." -ForegroundColor DarkGray
            $prev = $ErrorActionPreference
            $ErrorActionPreference = "Continue"
            podman-compose --env-file $envFilePath -f $composeFile -p $composeProject up -d mysql 2>&1 | Out-Null
            $ErrorActionPreference = $prev
            Start-Sleep -Seconds 20
            
            $mysqlPod = @(podman ps --filter "label=io.podman.compose.project=$composeProject" --format "{{.Names}}" | Where-Object { $_ -match "mysql" } | Select-Object -First 1)
            if ($mysqlPod) {
                for ($i = 0; $i -lt 30; $i++) {
                    $h = podman inspect $mysqlPod --format '{{.State.Health.Status}}' 2>$null
                    if ($h -eq 'healthy') { break }
                    Start-Sleep -Seconds 2
                }
            }
        }

        $mysqlPod = @(podman ps --filter "label=io.podman.compose.project=$composeProject" --format "{{.Names}}" | Where-Object { $_ -match "mysql" } | Select-Object -First 1)
        
        if ($mysqlPod) {
            $dumpFile = Join-Path $snapshotDir "database.sql"
            $dumpCmd = "mysqldump"
            $detectDump = podman exec $mysqlPod sh -c "command -v mariadb-dump" 2>$null
            if ($detectDump -and $detectDump.Trim() -ne "") {
                $dumpCmd = "mariadb-dump"
            }
            if ($LowSelectiveDb) {
                # ── LOW: Framework-only database export ──
                # Two files:
                #   database.sql        — schema only (CREATE TABLE IF NOT EXISTS, no DROPs, no data)
                #   framework-data.sql  — REPLACE INTO for wp_options, wp_users, wp_usermeta (safe upsert)
                Write-Host "  LOW snapshot: framework-only database export" -ForegroundColor DarkGray
                
                # Step 1: Schema dump with DROP TABLE IF EXISTS + CREATE TABLE, then post-process
                $schemaTemp = [System.IO.Path]::GetTempFileName() -replace '\.tmp$', '.sql'
                podman exec $mysqlPod $dumpCmd -uroot -p"$dbPass" --no-data --single-transaction --quick --lock-tables=false $dbName 2>$null | Out-File -FilePath $schemaTemp -Encoding UTF8 -ErrorAction SilentlyContinue
                
                # Post-process: remove DROP TABLE, change CREATE TABLE to CREATE TABLE IF NOT EXISTS
                $schemaContent = Get-Content $schemaTemp -Raw
                $schemaContent = $schemaContent -replace 'DROP TABLE IF EXISTS `[^`]+`;\s*', ''
                $schemaContent = $schemaContent -replace 'CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS '
                $schemaContent | Out-File -FilePath $dumpFile -Encoding UTF8 -NoNewline
                Remove-Item $schemaTemp -Force -ErrorAction SilentlyContinue
                Write-Host "  Schema exported (CREATE TABLE IF NOT EXISTS, no destructive DROPs)" -ForegroundColor DarkGray
                
                # Step 2: Framework data — REPLACE INTO for safe upsert (preserves runtime data)
                $frameworkDataFile = Join-Path $snapshotDir "framework-data.sql"
                "# LOW snapshot - framework data only (safe upsert, does NOT overwrite runtime data)`n" | Out-File -FilePath $frameworkDataFile -Encoding UTF8
                
                # wp_options: dump with INSERT, convert to REPLACE
                $optsTemp = [System.IO.Path]::GetTempFileName() -replace '\.tmp$', '.sql'
                podman exec $mysqlPod $dumpCmd -uroot -p"$dbPass" --no-create-info --skip-triggers --single-transaction --quick --lock-tables=false $dbName wp_options 2>$null | Out-File -FilePath $optsTemp -Encoding UTF8 -ErrorAction SilentlyContinue
                $optsContent = Get-Content $optsTemp -Raw
                $optsContent = $optsContent -replace 'INSERT INTO ', 'REPLACE INTO '
                $optsContent | Out-File -FilePath $frameworkDataFile -Append -Encoding UTF8
                Remove-Item $optsTemp -Force -ErrorAction SilentlyContinue
                
                # wp_users
                $usersTemp = [System.IO.Path]::GetTempFileName() -replace '\.tmp$', '.sql'
                podman exec $mysqlPod $dumpCmd -uroot -p"$dbPass" --no-create-info --skip-triggers --single-transaction --quick --lock-tables=false $dbName wp_users 2>$null | Out-File -FilePath $usersTemp -Encoding UTF8 -ErrorAction SilentlyContinue
                $usersContent = Get-Content $usersTemp -Raw
                $usersContent = $usersContent -replace 'INSERT INTO ', 'REPLACE INTO '
                $usersContent | Out-File -FilePath $frameworkDataFile -Append -Encoding UTF8
                Remove-Item $usersTemp -Force -ErrorAction SilentlyContinue
                
                # wp_usermeta
                $usermetaTemp = [System.IO.Path]::GetTempFileName() -replace '\.tmp$', '.sql'
                podman exec $mysqlPod $dumpCmd -uroot -p"$dbPass" --no-create-info --skip-triggers --single-transaction --quick --lock-tables=false $dbName wp_usermeta 2>$null | Out-File -FilePath $usermetaTemp -Encoding UTF8 -ErrorAction SilentlyContinue
                $usermetaContent = Get-Content $usermetaTemp -Raw
                $usermetaContent = $usermetaContent -replace 'INSERT INTO ', 'REPLACE INTO '
                $usermetaContent | Out-File -FilePath $frameworkDataFile -Append -Encoding UTF8
                Remove-Item $usermetaTemp -Force -ErrorAction SilentlyContinue
                
                Write-Host "  Framework data exported: wp_options, wp_users, wp_usermeta (REPLACE INTO - safe upsert)" -ForegroundColor Green
                Write-Host "  Excluded: posts, contractor data, media, comments, operational state" -ForegroundColor DarkGray
            } else {
                # ── Medium/High: Full database dump ──
                podman exec $mysqlPod $dumpCmd -uroot -p"$dbPass" --single-transaction --quick --lock-tables=false $dbName 2>$null | Out-File -FilePath $dumpFile -Encoding UTF8 -ErrorAction SilentlyContinue
            }

            if ($LowSelectiveDb) {
                # LOW: verify schema file AND framework data file
                $frameworkDataFile = Join-Path $snapshotDir "framework-data.sql"
                $schemaOk = (Test-Path $dumpFile) -and (Get-Item $dumpFile).Length -gt 100
                $frameworkOk = (Test-Path $frameworkDataFile) -and (Get-Item $frameworkDataFile).Length -gt 100
                if ($schemaOk -and $frameworkOk) {
                    $dbDumped = $true
                    $schemaSize = "{0:N0} KB" -f ((Get-Item $dumpFile).Length / 1KB)
                    $frameworkSize = "{0:N0} KB" -f ((Get-Item $frameworkDataFile).Length / 1KB)
                    Write-Host "  Database schema: $schemaSize" -ForegroundColor Green
                    Write-Host "  Framework data: $frameworkSize" -ForegroundColor Green
                } else {
                    Write-Warning "LOW database dump appears empty or failed."
                    Remove-Item $dumpFile -Force -ErrorAction SilentlyContinue
                    Remove-Item $frameworkDataFile -Force -ErrorAction SilentlyContinue
                }
            } else {
                if ((Test-Path $dumpFile) -and (Get-Item $dumpFile).Length -gt 100) {
                    $dbDumped = $true
                    $dumpSize = "{0:N0} KB" -f ((Get-Item $dumpFile).Length / 1KB)
                    Write-Host "  Database dumped: $dumpSize" -ForegroundColor Green
                } else {
                    Write-Warning "Database dump appears empty or failed."
                    Remove-Item $dumpFile -Force -ErrorAction SilentlyContinue
                }
            }

            if ($wasStopped) {
                Write-Host "  Stopping MySQL..." -ForegroundColor DarkGray
                $prev = $ErrorActionPreference
                $ErrorActionPreference = "Continue"
                podman-compose --env-file $envFilePath -f $composeFile -p $composeProject down 2>&1 | Out-Null
                $ErrorActionPreference = $prev
            }
        } else {
            Write-Warning "MySQL container not found. Skipping database dump."
        }
    }
}

# ── Step 3: Zip project files ───────────────────────────────
Write-Host "`nArchiving project files..." -ForegroundColor Cyan
$zipFile = Join-Path $snapshotDir "project.zip"

$excludeDirs = @(
    "wp-content/cache",
    "wp-content/upgrade",
    ".local",
    ".snapshots",
    "Snapshots",
    "backups",
    "clone",
    "node_modules",
    ".git",
    "tmp",
    "temp",
    "PROBOOK"
)

$excludeEnv = $false

if ($BackupLevel -eq "Medium" -or $BackupLevel -eq "Low") {
    $excludeDirs += "wp-content/uploads"
    $excludeDirs += "secrets"
    $excludeEnv = $true
}

if ($ExcludePaths) {
    $additionalExcludes = $ExcludePaths -split ',' | Where-Object { $_.Trim() -ne "" }
    foreach ($path in $additionalExcludes) {
        $excludeDirs += $path.Trim()
    }
}

$excludeExtensions = @(".sql", ".sql.gz", ".log")

# ── Read .gitignore patterns and convert to archiver exclusions ──
function Get-GitignoreExcludes {
    param([string]$ProjPath)
    
    $patterns = @()
    $gitignorePath = Join-Path $ProjPath ".gitignore"
    if (-not (Test-Path $gitignorePath)) { return $patterns }
    
    $lines = Get-Content $gitignorePath | Where-Object {
        $_.Trim() -ne "" -and -not $_.Trim().StartsWith("#")
    }
    
    foreach ($line in $lines) {
        $p = $line.Trim()
        # Skip negation patterns (!) — those are inclusions, not exclusions
        if ($p.StartsWith("!")) { continue }
        # Remove trailing slash for directory patterns
        $p = $p.TrimEnd('/')
        # Skip patterns that are too broad (would exclude everything)
        if ($p -eq "*" -or $p -eq "." -or $p -eq "..") { continue }
        # Skip gitignore-specific syntax we don't support
        if ($p -match '[\*\?\[\]]' -and $p -notmatch '/\*\*$') {
            # Patterns with wildcards that aren't simple directory/** — skip for safety
            if ($p -notmatch '^\*\.[a-z]+$') {
                continue
            }
        }
        $patterns += $p
    }
    
    return $patterns
}

# Only apply .gitignore patterns for Medium/Low (git-deploy) levels.
# High level (disaster recovery) keeps everything including env files and uploads.
$gitignoreExcludes = @()
if ($BackupLevel -eq "Medium" -or $BackupLevel -eq "Low") {
    $gitignoreExcludes = Get-GitignoreExcludes -ProjPath $Source
    if ($gitignoreExcludes.Count -gt 0) {
        Write-Host "  Loaded $($gitignoreExcludes.Count) .gitignore exclusion patterns" -ForegroundColor DarkGray
    }
}

function Should-Exclude {
    param([string]$RelativePath)
    
    $normalized = $RelativePath.Replace('\', '/').Trim('/')
    $filename = [System.IO.Path]::GetFileName($normalized).ToLower()
    $ext = [System.IO.Path]::GetExtension($normalized).ToLower()
    
    # Check hardcoded exclude dirs
    foreach ($d in $excludeDirs) {
        $normD = $d.Replace('\', '/').Trim('/')
        if ($normalized -eq $normD -or 
            $normalized.StartsWith("$normD/") -or 
            $normalized.EndsWith("/$normD") -or 
            $normalized -like "*/$normD/*") {
            return $true
        }
    }
    
    # Check hardcoded extensions
    if ($ext -in $excludeExtensions) { return $true }
    
    # Check .env exclusions (for Medium/Low levels)
    if ($excludeEnv) {
        if ($filename -eq ".env" -or ($filename.StartsWith(".env.") -and -not $filename.EndsWith(".example"))) {
            return $true
        }
    }
    
    # Check .gitignore patterns
    foreach ($p in $gitignoreExcludes) {
        $normP = $p.Replace('\', '/').Trim('/')
        # Simple filename match (e.g. "*.sql", "*.log")
        if ($normP.StartsWith("*.")) {
            $matchExt = $normP.Substring(1)
            if ($filename.EndsWith($matchExt)) { return $true }
            continue
        }
        # Exact directory/file match
        if ($normalized -eq $normP) { return $true }
        # Path starts with pattern (e.g. "wordpress/wp-content/plugins/elementor/")
        if ($normalized.StartsWith("$normP/")) { return $true }
        # Path contains the pattern as a directory component
        if ($normalized -like "*/$normP/*" -or $normalized -like "*/$normP") { return $true }
        # Pattern is just a directory name — match anywhere in path
        if ($normP -notmatch '/' -and $normalized -match "(^|/)$([regex]::Escape($normP))(/|`$)") {
            return $true
        }
    }
    
    return $false
}

$allFiles = Get-ChildItem -Path $Source -Recurse -File -ErrorAction SilentlyContinue
$filesToArchive = @($allFiles | Where-Object {
    $rel = $_.FullName.Substring($Source.Length + 1)
    -not (Should-Exclude -RelativePath $rel)
})

$fileCount = $filesToArchive.Count
if ($fileCount -gt 0) {
    try {
        Add-Type -AssemblyName System.IO.Compression | Out-Null
        Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
        $zip = [System.IO.Compression.ZipFile]::Open($zipFile, [System.IO.Compression.ZipArchiveMode]::Create)
        foreach ($file in $filesToArchive) {
            $relPath = $file.FullName.Substring($Source.Length).TrimStart('\', '/').Replace('\', '/')
            $null = [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $relPath)
        }
        $zip.Dispose()
        $zipSize = "{0:N0} MB" -f ((Get-Item $zipFile).Length / 1MB)
        Write-Host "  Archived: $fileCount files ($zipSize)" -ForegroundColor Green
    } catch {
        if ($null -ne $zip) { $zip.Dispose() }
        Write-Warning "Archive failed: $($_.Exception.Message)"
        throw $_
    }
}

# ── Step 4: Metadata ────────────────────────────────────────
Write-Host "`nWriting metadata..." -ForegroundColor Cyan

$gitCommit = try { git -C $Source rev-parse --short HEAD 2>$null } catch { "unknown" }
$gitBranch = try { git -C $Source rev-parse --abbrev-ref HEAD 2>$null } catch { "unknown" }

$metadata = @{
    version              = "1.0"
    timestamp            = (Get-Date -Format "yyyy-MM-ddTHH:mm:sszzz")
    project              = $Project
    description          = $Description
    containers_running   = $containersRunning
    database_included    = $dbDumped
    low_selective_db     = $LowSelectiveDb
    files_count          = $fileCount
    size_bytes           = if (Test-Path $zipFile) { (Get-Item $zipFile).Length } else { 0 }
    source_path          = $Source
    compose_project      = $composeProject
    compose_file         = $composeFile
    powered_off_snapshot = $wasStopped
    git_commit           = $gitCommit
    git_branch           = $gitBranch
    backup_level         = $BackupLevel
}
$metadata | ConvertTo-Json -Depth 4 | Out-File -FilePath (Join-Path $snapshotDir "snapshot.json") -Encoding UTF8

# recovery.md
$dbDescription = if ($LowSelectiveDb) {
    "framework-only (wp_options, wp_users, wp_usermeta data + schema for all tables)"
} elseif ($dbDumped) {
    "database.sql (full dump)"
} else {
    "not included"
}

$levelDescription = switch ($BackupLevel) {
    "Low"    { "Safe development rollback - framework and application logic only. Does NOT overwrite contractor runtime data or uploads." }
    "Medium" { "Code + database - excludes uploads and secrets. Suitable for git deployment." }
    "High"   { "Complete recovery state - full disaster recovery image including uploads, secrets, and database." }
    default  { "" }
}

$recoveryMd = @"
# Recovery Snapshot - $timestamp

## Level: $BackupLevel
$levelDescription

## Description
$Description

## Recovery Instructions
1. Run `C:\ESSOP\panel.ps1` (PowerShell admin panel)
2. Find this snapshot (`$timestamp`)
3. Click **Restore Selected**

Or from PowerShell:
```
C:\ESSOP\Restore-Snapshot.ps1 -Project $Project -SnapshotName $timestamp
```

## Contents
- Project files: `project.zip` ($fileCount files)
- Database: $dbDescription
- Source: $Source
- Compose: $composeProject
$(if ($wasStopped) { "- Powered-off snapshot (consistent)" } else { "- Live snapshot" })
$(if ($LowSelectiveDb) { "- Framework tables exported: wp_options, wp_users, wp_usermeta`n- Excluded: posts, contractor data, media, comments, operational state" } else { "" })

## Git
- Branch: $gitBranch
- Commit: $gitCommit
"@
$recoveryMd | Out-File -FilePath (Join-Path $snapshotDir "recovery.md") -Encoding UTF8

# ── Step 5: Restart containers ──────────────────────────────
if ($wasStopped) {
    Write-Host "`nRestarting containers..." -ForegroundColor Cyan
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    podman-compose --env-file $envFilePath -f $composeFile -p $composeProject up -d 2>&1 | Out-Null
    $ErrorActionPreference = $prev
    Write-Host "Containers restarted." -ForegroundColor Green
}

# ── Step 6: Update active.txt ───────────────────────────────
$activeFile = Join-Path $ProjectSnapshotsRoot "active.txt"
$timestamp | Out-File -FilePath $activeFile -Encoding UTF8 -NoNewline

# ── Step 8: Enforce snapshot retention limit ────────────────
Write-Host "`nEnforcing $RetentionCount-snapshot retention limit..." -ForegroundColor Cyan
$projectDir = $ProjectSnapshotsRoot
if (Test-Path $projectDir) {
    $snapshots = Get-ChildItem -Path $projectDir -Directory | Where-Object {
        Test-Path (Join-Path $_.FullName "snapshot.json")
    } | Sort-Object Name -Descending
    
    if ($snapshots.Count -gt $RetentionCount) {
        $toDelete = $snapshots[$RetentionCount..($snapshots.Count - 1)]
        Write-Host "Found $($snapshots.Count) snapshots. Deleting $($toDelete.Count) older snapshot(s) to enforce limit of $RetentionCount..." -ForegroundColor Yellow
        foreach ($snapToDelete in $toDelete) {
            Write-Host "  Deleting oldest snapshot: $($snapToDelete.Name)" -ForegroundColor DarkGray
            Remove-Item -Path $snapToDelete.FullName -Recurse -Force -ErrorAction SilentlyContinue
        }
    } else {
        Write-Host "Snapshots count ($($snapshots.Count)) is within limit of $RetentionCount. No pruning needed." -ForegroundColor Green
    }
}

# ── Step 7: Refresh registry ─────────────────────────────────
$refreshScript = Join-Path $PSScriptRoot "Refresh-Registry.ps1"
if (Test-Path $refreshScript) {
    & $refreshScript
}

# ── Summary ─────────────────────────────────────────────────
Write-Host "`n=== Snapshot Complete ===" -ForegroundColor Green
Write-Host "Location: $snapshotDir" -ForegroundColor White
Write-Host "Files   : project.zip ($fileCount files)" -ForegroundColor White
if ($dbDumped) { Write-Host "Database: database.sql" -ForegroundColor White }
Write-Host "Type    : $(if ($wasStopped) { 'Powered-off (consistent)' } else { 'Live' })" -ForegroundColor White
Write-Host "Status  : active.txt updated to $timestamp" -ForegroundColor Cyan
