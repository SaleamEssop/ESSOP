#Requires -Version 5.1
<#
.SYNOPSIS
  Restores a MyPools project from a snapshot. Full disaster recovery.
.PARAMETER Project
  Project name (default: mypools).
.PARAMETER SnapshotName
  Snapshot directory to restore from (e.g. "2026-05-21-1430"). Default: latest.
.PARAMETER SourcePath
  Path to project root. Default: from snapshot metadata.
.PARAMETER SkipPreBackup
  Skip automatic pre-restore safety snapshot. NOT RECOMMENDED.
.EXAMPLE
  .\Restore-Snapshot.ps1 -Project mypools -SnapshotName "2026-05-21-1430"
#>

param(
    [string]$Project = "mypools",
    [string]$SnapshotName,
    [string]$SourcePath,
    [switch]$SkipPreBackup,
    [switch]$Force
)

$ErrorActionPreference = "Stop"

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
        "snapshots"      = "C:\snapshots"
        "mycities"       = "C:\Docker\projects\mycities"
        "deepseek-tunnel" = "C:\Podman\ngrok"
    }

    if ($known.ContainsKey($Proj)) {
        $p = $known[$Proj]
        if (Test-Path $p) { return (Resolve-Path $p).Path }
    }

    throw "Cannot resolve source path for project '$Proj'. Use -SourcePath to specify."
}

$Source = Get-ProjectSourcePath -Proj $Project
$projectSnapshotDir = Join-Path $Source ".snapshots"

if (-not $SnapshotName) {
    $activeFile = Join-Path $projectSnapshotDir "active.txt"
    if (-not (Test-Path $activeFile)) {
        # Fallback to legacy active.txt
        $legacyActiveFile = Join-Path "C:\snapshots\$Project" "active.txt"
        if (Test-Path $legacyActiveFile) {
            $activeFile = $legacyActiveFile
        } else {
            throw "No active.txt and no -SnapshotName specified."
        }
    }
    $SnapshotName = (Get-Content $activeFile -Raw).Trim()
    Write-Host "Using latest: $SnapshotName" -ForegroundColor Cyan
}

$snapshotDir = Join-Path $projectSnapshotDir $SnapshotName
if (-not (Test-Path $snapshotDir)) {
    # Fallback to legacy path C:\snapshots\<Project>\<SnapshotName>
    $legacyDir = Join-Path "C:\snapshots\$Project" $SnapshotName
    if (Test-Path $legacyDir) {
        $snapshotDir = $legacyDir
    } else {
        throw "Snapshot not found: $snapshotDir"
    }
}

$snapshotJson = Join-Path $snapshotDir "snapshot.json"
if (-not (Test-Path $snapshotJson)) { throw "Not a valid snapshot: missing snapshot.json" }

$meta = Get-Content $snapshotJson -Raw | ConvertFrom-Json
$level = if ($meta.backup_level) { $meta.backup_level } else { "High" }
Write-Host "`n=== Snapshot Restore ===" -ForegroundColor Cyan
Write-Host "Snapshot  : $SnapshotName" -ForegroundColor White
Write-Host "Level     : $level" -ForegroundColor Yellow
Write-Host "Description: $($meta.description)" -ForegroundColor White
Write-Host "Created   : $($meta.timestamp)" -ForegroundColor White

$composeProject = $meta.compose_project
$composeFile = Join-Path $Source "compose.yml"
$envFilePath = if (Test-Path (Join-Path $Source ".env.local")) { Join-Path $Source ".env.local" } else { Join-Path $Source ".env" }

$envVars = @{}
if ($envFilePath -and (Test-Path $envFilePath)) {
    Get-Content $envFilePath | ForEach-Object {
        $line = $_.Trim()
        if ($line -eq '' -or $line.StartsWith('#')) { return }
        if ($line -match '^([^=]+)=(.*)$') {
            $envVars[$matches[1].Trim()] = $matches[2].Trim().Trim('"').Trim("'")
        }
    }
}

Write-Host "Target    : $Source" -ForegroundColor White

Write-Host "`nWARNING: This will OVERWRITE the current project." -ForegroundColor Yellow
if (-not $Force) {
    $confirm = Read-Host "Type RESTORE to continue"
    if ($confirm -ne "RESTORE") { Write-Host "Cancelled." -ForegroundColor Red; exit 0 }
} else {
    Write-Host "Bypassing confirmation prompt (-Force is active)." -ForegroundColor Green
}

if (-not (Get-Command podman -ErrorAction SilentlyContinue)) { throw "podman not in PATH" }
$pc = Get-Command podman-compose -ErrorAction SilentlyContinue
if ($pc) { $env:PODMAN_COMPOSE_PROVIDER = $pc.Source }

if (-not $SkipPreBackup -and (Test-Path $Source)) {
    Write-Host "`nCreating pre-restore safety snapshot..." -ForegroundColor Cyan
    $createScript = Join-Path $PSScriptRoot "Create-Snapshot.ps1"
    if (Test-Path $createScript) {
        & $createScript -Project $Project -Description "PRE-RESTORE safety backup before restoring $SnapshotName" -SourcePath $Source -Live -NoDatabase
    }
}

Write-Host "`nStopping containers..." -ForegroundColor Cyan
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
if ($envFilePath -and (Test-Path $envFilePath)) {
    podman-compose --env-file $envFilePath -f $composeFile -p $composeProject down 2>&1 | Out-Null
} else {
    podman-compose -f $composeFile -p $composeProject down 2>&1 | Out-Null
}
$ErrorActionPreference = $prev
Write-Host "Containers stopped." -ForegroundColor Green

$zipFile = Join-Path $snapshotDir "project.zip"
if (Test-Path $zipFile) {
    Write-Host "`nExtracting project files..." -ForegroundColor Cyan
    if (-not (Test-Path $Source)) { New-Item -ItemType Directory -Path $Source -Force | Out-Null }
    Expand-Archive -Path $zipFile -DestinationPath $Source -Force
    Write-Host "Files extracted." -ForegroundColor Green
} else {
    Write-Warning "project.zip not found, skipping file restore."
}

$sqlFile = Join-Path $snapshotDir "database.sql"
if (Test-Path $sqlFile) {
    Write-Host "`nStarting MySQL for import..." -ForegroundColor Cyan
    $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    if ($envFilePath -and (Test-Path $envFilePath)) {
        podman-compose --env-file $envFilePath -f $composeFile -p $composeProject up -d mysql 2>&1 | Out-Null
    } else {
        podman-compose -f $composeFile -p $composeProject up -d mysql 2>&1 | Out-Null
    }
    $ErrorActionPreference = $prev
    Start-Sleep -Seconds 20

    $mysqlPod = @(podman ps --filter "label=io.podman.compose.project=$composeProject" --format "{{.Names}}" | Where-Object { $_ -match "mysql" } | Select-Object -First 1)
    if (-not $mysqlPod) { throw "MySQL container failed to start." }

    for ($i = 0; $i -lt 30; $i++) {
        $h = podman inspect $mysqlPod --format '{{.State.Health.Status}}' 2>$null
        if ($h -eq 'healthy') { break }
        Start-Sleep -Seconds 2
    }

    # envVars already parsed at top
    $dbPass = if ($envVars['MYSQL_ROOT_PASSWORD']) { $envVars['MYSQL_ROOT_PASSWORD'] } else { "" }
    $dbName = if ($envVars['MYSQL_DATABASE']) { $envVars['MYSQL_DATABASE'] } else { $Project }

    Write-Host "Importing database..." -ForegroundColor Cyan
    Get-Content $sqlFile -Raw | podman exec -i $mysqlPod mariadb -uroot -p"$dbPass" $dbName 2>$null
    Write-Host "Database imported." -ForegroundColor Green

    $localUrl = if ($envVars['LOCAL_URL']) { $envVars['LOCAL_URL'] } else { "http://127.0.0.1:$($envVars['APP_HTTP_PORT'])" }
    "UPDATE wp_options SET option_value='$localUrl' WHERE option_name IN ('siteurl','home');" | podman exec -i $mysqlPod mariadb -uroot -p"$dbPass" $dbName 2>$null

    Write-Host "Stopping MySQL..." -ForegroundColor DarkGray
    $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    if ($envFilePath -and (Test-Path $envFilePath)) {
        podman-compose --env-file $envFilePath -f $composeFile -p $composeProject down 2>&1 | Out-Null
    } else {
        podman-compose -f $composeFile -p $composeProject down 2>&1 | Out-Null
    }
    $ErrorActionPreference = $prev
}

Write-Host "`nStarting full stack..." -ForegroundColor Cyan
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
if ($envFilePath -and (Test-Path $envFilePath)) {
    podman-compose --env-file $envFilePath -f $composeFile -p $composeProject up -d 2>&1 | Out-Null
} else {
    podman-compose -f $composeFile -p $composeProject up -d 2>&1 | Out-Null
}
$ErrorActionPreference = $prev
Start-Sleep -Seconds 5

$running = @(podman ps --filter "label=io.podman.compose.project=$composeProject" --format "{{.Names}}" 2>$null)
Write-Host "`n=== Restore Complete ===" -ForegroundColor Green
Write-Host "Running: $($running -join ', ')" -ForegroundColor Green
Write-Host "URL: http://127.0.0.1:$($envVars['APP_HTTP_PORT'])/" -ForegroundColor Cyan
