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
    [string]$ExcludePaths = "",
    [int]$RetentionCount = 0
)

$ErrorActionPreference = "Stop"
$script:SnapshotsRoot = "C:\snapshots"

# ── Resolve project source path ────────────────────────────
function Get-ProjectSourcePath {
    param([string]$Proj)

    if ($SourcePath -and (Test-Path $SourcePath)) {
        return (Resolve-Path $SourcePath).Path
    }

    $projectsFile = Join-Path $script:SnapshotsRoot "projects.json"
    if (Test-Path $projectsFile) {
        try {
            $projs = Get-Content $projectsFile -Raw | ConvertFrom-Json
            $found = $projs | Where-Object { $_.name -eq $Proj } | Select-Object -First 1
            if ($found -and (Test-Path $found.path)) {
                return $found.path
            }
        } catch {}
    }

    $known = @{
        "mypools"        = "C:\Podman\MyPools"
        "mycities"       = "C:\Docker\projects\mycities"
        "deepseek-tunnel" = "C:\Podman\ngrok"
    }

    if ($known.ContainsKey($Proj)) {
        $p = $known[$Proj]
        if (Test-Path $p) { return $p }
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
Write-Host "[PROGRESS] 5% (Resolving paths and loading environment)"
Write-Host "`n=== MyPools Snapshot - Create ===" -ForegroundColor Cyan

$Source = Get-ProjectSourcePath -Proj $Project
Write-Host "Project: $Project" -ForegroundColor White
Write-Host "Source : $Source" -ForegroundColor White

$envVars = Read-ComposeEnv -ProjPath $Source
$composeProject = if ($envVars['COMPOSE_PROJECT_NAME']) { $envVars['COMPOSE_PROJECT_NAME'] } else { "$Project-local" }
$composeFile = Join-Path $Source "compose.yml"
if (-not (Test-Path $composeFile)) { throw "compose.yml not found at $composeFile" }
$envFilePath = if (Test-Path (Join-Path $Source ".env.local")) { Join-Path $Source ".env.local" } else { Join-Path $Source ".env" }

$timestamp = Get-Date -Format "yyyy-MM-dd-HHmm"
$snapsPath = Join-Path $Source ".snapshots"
$snapshotDir = Join-Path $snapsPath $timestamp
New-Item -ItemType Directory -Path $snapshotDir -Force | Out-Null
Write-Host "Snapshot: $snapshotDir" -ForegroundColor White

# Update gitignore
$gitignorePath = Join-Path $Source ".gitignore"
$ignoreEntries = @(".snapshots/", ".local/")
if (Test-Path $gitignorePath) {
    $content = Get-Content $gitignorePath
    $toAppend = @()
    foreach ($entry in $ignoreEntries) {
        if ($content -notcontains $entry) {
            $toAppend += $entry
        }
    }
    if ($toAppend.Count -gt 0) {
        $toAppend | Out-File -FilePath $gitignorePath -Encoding UTF8 -Append
    }
} else {
    $ignoreEntries | Out-File -FilePath $gitignorePath -Encoding UTF8
}

if (-not ($NoDatabase -and $Live)) {
    if (-not (Get-Command podman -ErrorAction SilentlyContinue)) {
        throw "podman not in PATH (required for database dump or container stop/start)"
    }
    Set-ComposeProvider | Out-Null

    $containers = @(podman ps --filter "label=io.podman.compose.project=$composeProject" --format "{{.Names}}" 2>$null)
    $containersRunning = $containers.Count -gt 0
    if ($containersRunning) {
        Write-Host "Containers running: $($containers -join ', ')" -ForegroundColor Green
    } else {
        Write-Host "No containers running for $composeProject" -ForegroundColor Yellow
    }
} else {
    $containersRunning = $false
    Write-Host "Podman skipped (NoDatabase + Live mode)" -ForegroundColor DarkGray
}

# ── Step 1: Stop containers ─────────────────────────────────
$wasStopped = $false
if (-not $Live -and $containersRunning) {
    Write-Host "[PROGRESS] 10% (Stopping containers for consistent snapshot...)"
    Write-Host "`nStopping containers for consistent snapshot..." -ForegroundColor Cyan
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    podman compose --env-file $envFilePath -f $composeFile -p $composeProject down 2>&1 | Out-Null
    $ErrorActionPreference = $prev
    $wasStopped = $true
    Write-Host "Containers stopped." -ForegroundColor Green
}

# ── Step 2: Database dump ───────────────────────────────────
$dbDumped = $false
if (-not $NoDatabase) {
    Write-Host "[PROGRESS] 20% (Preparing database dump...)"
    Write-Host "`nDumping database..." -ForegroundColor Cyan

    $dbName = if ($envVars['MYSQL_DATABASE']) { $envVars['MYSQL_DATABASE'] } else { $Project }
    $dbPass = if ($envVars['MYSQL_ROOT_PASSWORD']) { $envVars['MYSQL_ROOT_PASSWORD'] } elseif ($envVars['MYSQL_PASSWORD']) { $envVars['MYSQL_PASSWORD'] } else { "" }

    if (-not $dbPass) {
        Write-Warning "No DB password found in env file. Skipping database dump."
    } else {
        # If containers were stopped, start just mysql for the dump
        if ($wasStopped) {
            Write-Host "[PROGRESS] 25% (Starting MySQL temporarily for database dump...)"
            Write-Host "  Starting MySQL temporarily for dump..." -ForegroundColor DarkGray
            $prev = $ErrorActionPreference
            $ErrorActionPreference = "Continue"
            podman compose --env-file $envFilePath -f $composeFile -p $composeProject up -d mysql 2>&1 | Out-Null
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
            Write-Host "[PROGRESS] 35% (Executing database dump...)"
            $dumpFile = Join-Path $snapshotDir "database.sql"

            # Probe which dump command works inside the container
            $dumpCmd = "mariadb-dump"
            $prevError = $ErrorActionPreference
            $ErrorActionPreference = "Continue"
            
            # Check if mariadb-dump works
            podman exec $mysqlPod mariadb-dump --version 2>$null | Out-Null
            $mariadbDumpExit = $LASTEXITCODE
            
            # Check if mysqldump works
            podman exec $mysqlPod mysqldump --version 2>$null | Out-Null
            $mysqldumpExit = $LASTEXITCODE
            
            $ErrorActionPreference = $prevError

            if ($mariadbDumpExit -eq 0) {
                $dumpCmd = "mariadb-dump"
            } elseif ($mysqldumpExit -eq 0) {
                $dumpCmd = "mysqldump"
            } else {
                throw "Neither 'mariadb-dump' nor 'mysqldump' database dump binary was found or could be executed in container $mysqlPod."
            }

            podman exec $mysqlPod $dumpCmd -uroot -p"$dbPass" --single-transaction --quick --lock-tables=false $dbName 2>$null | Out-File -FilePath $dumpFile -Encoding UTF8 -ErrorAction SilentlyContinue

            if ((Test-Path $dumpFile) -and (Get-Item $dumpFile).Length -gt 100) {
                $dbDumped = $true
                $dumpSize = "{0:N0} KB" -f ((Get-Item $dumpFile).Length / 1KB)
                Write-Host "  Database dumped: $dumpSize" -ForegroundColor Green
            } else {
                Write-Warning "Database dump appears empty or failed."
                Remove-Item $dumpFile -Force -ErrorAction SilentlyContinue
            }

            if ($wasStopped) {
                Write-Host "  Stopping MySQL..." -ForegroundColor DarkGray
                $prev = $ErrorActionPreference
                $ErrorActionPreference = "Continue"
                podman compose --env-file $envFilePath -f $composeFile -p $composeProject down 2>&1 | Out-Null
                $ErrorActionPreference = $prev
            }
        } else {
            Write-Warning "MySQL container not found. Skipping database dump."
        }
    }
}

# ── Step 3: Zip project files ───────────────────────────────
Write-Host "[PROGRESS] 40% (Scanning project files for archive...)"
Write-Host "`nArchiving project files..." -ForegroundColor Cyan
$zipFile = Join-Path $snapshotDir "project.zip"

$excludeDirs = @(
    "wp-content\uploads",
    "wp-content\cache",
    "wp-content\upgrade",
    ".local",
    ".snapshots",
    "secrets",
    "backups",
    "clone",
    "node_modules",
    ".git",
    "tmp",
    "temp",
    "PROBOOK"
)

if ($ExcludePaths) {
    $customExcludes = $ExcludePaths.Split(",") | ForEach-Object { $_.Trim() }
    foreach ($ce in $customExcludes) {
        if ($ce -and $excludeDirs -notcontains $ce) {
            $excludeDirs += $ce
        }
    }
}

$excludeExtensions = @(".sql", ".sql.gz", ".log")

function Should-Exclude {
    param([string]$RelativePath)
    foreach ($d in $excludeDirs) {
        if ($RelativePath.StartsWith($d, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    $ext = [System.IO.Path]::GetExtension($RelativePath).ToLower()
    if ($ext -in $excludeExtensions) { return $true }
    if ($RelativePath -eq ".env" -or $RelativePath -eq ".env.local" -or $RelativePath.EndsWith(".env.local")) { return $true }
    return $false
}

$allFiles = Get-ChildItem -Path $Source -Recurse -File -ErrorAction SilentlyContinue
$filesToArchive = @($allFiles | Where-Object {
    $rel = $_.FullName.Substring($Source.Length + 1)
    -not (Should-Exclude -RelativePath $rel)
})

$fileCount = $filesToArchive.Count
if ($fileCount -gt 0) {
    Write-Host "Adding compression assemblies..." -ForegroundColor DarkGray
    Add-Type -AssemblyName "System.IO.Compression"
    Add-Type -AssemblyName "System.IO.Compression.FileSystem"

    Write-Host "Creating zip archive..." -ForegroundColor DarkGray
    $zipStream = [System.IO.File]::Create($zipFile)
    $zipArchive = New-Object System.IO.Compression.ZipArchive($zipStream, [System.IO.Compression.ZipArchiveMode]::Create)

    try {
        $i = 0
        $lastPct = -1
        $lastLoggedCount = 0
        foreach ($file in $filesToArchive) {
            $i++
            $rel = $file.FullName.Substring($Source.Length + 1)
            # Replace backslashes with forward slashes for zip compatibility
            $relZipPath = $rel.Replace("\", "/")
            
            # Progress calculation (from 40% to 85%)
            $pct = [int](40 + ($i / $fileCount) * 45)
            
            # Log progress only when percentage changes or every 200 files, or on the first/last file
            if ($pct -ne $lastPct -or ($i - $lastLoggedCount) -ge 200 -or $i -eq 1 -or $i -eq $fileCount) {
                Write-Host "[PROGRESS] $pct% (Archiving: $i/$fileCount files - $relZipPath)"
                $lastPct = $pct
                $lastLoggedCount = $i
            }

            try {
                [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zipArchive, $file.FullName, $relZipPath, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
            } catch {
                Write-Warning "Failed to archive file: $rel. Error: $($_.Exception.Message)"
            }
        }
    } finally {
        if ($zipArchive) { $zipArchive.Dispose() }
        if ($zipStream) { $zipStream.Dispose() }
    }
    
    if (Test-Path $zipFile) {
        $zipSize = "{0:N0} MB" -f ((Get-Item $zipFile).Length / 1MB)
        Write-Host "  Archived: $fileCount files ($zipSize)" -ForegroundColor Green
    } else {
        Write-Warning "Archive creation failed or empty."
    }
}

# ── Step 4: Metadata ────────────────────────────────────────
Write-Host "[PROGRESS] 90% (Writing snapshot metadata)"
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
    files_count          = $fileCount
    size_bytes           = if (Test-Path $zipFile) { (Get-Item $zipFile).Length } else { 0 }
    source_path          = $Source
    compose_project      = $composeProject
    compose_file         = $composeFile
    powered_off_snapshot = $wasStopped
    git_commit           = $gitCommit
    git_branch           = $gitBranch
}
$metadata | ConvertTo-Json -Depth 4 | Out-File -FilePath (Join-Path $snapshotDir "snapshot.json") -Encoding UTF8

# recovery.md
$recoveryMd = @"
# Recovery Snapshot - $timestamp

## Description
$Description

## Recovery Instructions
1. Run `C:\snapshots\panel.ps1` (PowerShell admin panel)
2. Find this snapshot (`$timestamp`)
3. Click **Restore Selected**

Or from PowerShell:
```
C:\snapshots\Restore-Snapshot.ps1 -Project $Project -SnapshotName $timestamp
```

## Contents
- Project files: `project.zip` ($fileCount files)
- Database: $(if ($dbDumped) { "database.sql" } else { "not included" })
- Source: $Source
- Compose: $composeProject
$(if ($wasStopped) { "- Powered-off snapshot (consistent)" } else { "- Live snapshot" })

## Git
- Branch: $gitBranch
- Commit: $gitCommit
"@
$recoveryMd | Out-File -FilePath (Join-Path $snapshotDir "recovery.md") -Encoding UTF8

# ── Step 5: Restart containers ──────────────────────────────
if ($wasStopped) {
    Write-Host "[PROGRESS] 95% (Restarting containers...)"
    Write-Host "`nRestarting containers..." -ForegroundColor Cyan
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    podman compose --env-file $envFilePath -f $composeFile -p $composeProject up -d 2>&1 | Out-Null
    $ErrorActionPreference = $prev
    Write-Host "Containers restarted." -ForegroundColor Green
}

# ── Step 6: Update active.txt ───────────────────────────────
$activeFile = Join-Path $Source ".snapshots\active.txt"
$timestamp | Out-File -FilePath $activeFile -Encoding UTF8 -NoNewline

# ── Step 6.5: Prune old snapshots based on Retention Policy ──
if ($RetentionCount -gt 0) {
    Write-Host "`nPruning old snapshots (Retention Limit: $RetentionCount)..." -ForegroundColor Cyan
    $existingSnaps = @(Get-ChildItem -Path $snapsPath -Directory -ErrorAction SilentlyContinue | Where-Object {
        Test-Path (Join-Path $_.FullName "snapshot.json")
    } | Sort-Object Name -Descending)

    if ($existingSnaps.Count -gt $RetentionCount) {
        $toDelete = $existingSnaps | Select-Object -Skip $RetentionCount
        foreach ($snap in $toDelete) {
            Write-Host "Pruning old snapshot directory: $($snap.Name)" -ForegroundColor Yellow
            Remove-Item -Path $snap.FullName -Recurse -Force | Out-Null
        }
    }
}

# ── Step 7: Refresh registry ─────────────────────────────────
$refreshScript = Join-Path $SnapshotsRoot "Refresh-Registry.ps1"
if (Test-Path $refreshScript) {
    & $refreshScript
}

# ── Summary ─────────────────────────────────────────────────
Write-Host "[PROGRESS] 100% (Snapshot complete)"
Write-Host "`n=== Snapshot Complete ===" -ForegroundColor Green
Write-Host "Location: $snapshotDir" -ForegroundColor White
Write-Host "Files   : project.zip ($fileCount files)" -ForegroundColor White
if ($dbDumped) { Write-Host "Database: database.sql" -ForegroundColor White }
Write-Host "Type    : $(if ($wasStopped) { 'Powered-off (consistent)' } else { 'Live' })" -ForegroundColor White
Write-Host "Status  : active.txt updated to $timestamp" -ForegroundColor Cyan
