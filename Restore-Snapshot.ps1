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
    [switch]$ConfirmRestore
)

$ErrorActionPreference = "Stop"
$SnapshotsRoot = $PSScriptRoot

# ── Resolve project source path ────────────────────────────
function Get-ProjectSourcePath {
    param([string]$Proj)

    if ($SourcePath -and (Test-Path $SourcePath)) {
        return (Resolve-Path $SourcePath).Path
    }

    $projectsFile = Join-Path $SnapshotsRoot "projects.json"
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
        "mypools"        = "C:\mypools"
        "mycities"       = "C:\mycities"
        "deepseek-tunnel" = "C:\deepseek-tunnel"
    }

    if ($known.ContainsKey($Proj)) {
        $p = $known[$Proj]
        if (Test-Path $p) { return $p }
    }

    throw "Cannot resolve source path for project '$Proj'. Use -SourcePath to specify."
}

$Source = Get-ProjectSourcePath -Proj $Project

# Try local snapshots folder first
$projectSnapshotDir = Join-Path $Source "snapshots"
if (-not (Test-Path $projectSnapshotDir)) {
    # Try .snapshots for backward compatibility
    $projectSnapshotDir = Join-Path $Source ".snapshots"
}
if (-not (Test-Path $projectSnapshotDir)) {
    # Fallback to C:\snapshots\<Project>
    $projectSnapshotDir = Join-Path $SnapshotsRoot $Project
}

if (-not $SnapshotName) {
    $activeFile = Join-Path $projectSnapshotDir "active.txt"
    if (-not (Test-Path $activeFile)) {
        throw "No active.txt and no -SnapshotName specified."
    }
    $SnapshotName = (Get-Content $activeFile -Raw).Trim()
    Write-Host "Using latest: $SnapshotName" -ForegroundColor Cyan
}

$snapshotDir = Join-Path $projectSnapshotDir $SnapshotName
if (-not (Test-Path $snapshotDir)) { throw "Snapshot not found: $snapshotDir" }

$snapshotJson = Join-Path $snapshotDir "snapshot.json"
if (-not (Test-Path $snapshotJson)) { throw "Not a valid snapshot: missing snapshot.json" }

$meta = Get-Content $snapshotJson -Raw | ConvertFrom-Json
Write-Host "`n=== Snapshot Restore ===" -ForegroundColor Cyan
Write-Host "Snapshot  : $SnapshotName" -ForegroundColor White
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
if (-not $ConfirmRestore) {
    $confirm = Read-Host "Type RESTORE to continue"
    if ($confirm -ne "RESTORE") { Write-Host "Cancelled." -ForegroundColor Red; exit 0 }
} else {
    Write-Host "Confirmation received via command switch." -ForegroundColor Green
}

Write-Host "`n[Restoring State ....]" -ForegroundColor Yellow

Write-Host "[PROGRESS] 5% (Verifying environment)"
if (-not (Get-Command podman -ErrorAction SilentlyContinue)) { throw "podman not in PATH" }
$pc = Get-Command podman-compose -ErrorAction SilentlyContinue
if ($pc) { $env:PODMAN_COMPOSE_PROVIDER = $pc.Source }

if (-not $SkipPreBackup -and (Test-Path $Source)) {
    Write-Host "[PROGRESS] 10% (Creating safety pre-backup...)"
    Write-Host "`nCreating pre-restore safety snapshot..." -ForegroundColor Cyan
    $createScript = Join-Path $SnapshotsRoot "Create-Snapshot.ps1"
    if (Test-Path $createScript) {
        & $createScript -Project $Project -Description "PRE-RESTORE safety backup before restoring $SnapshotName" -SourcePath $Source -Live -NoDatabase
    }
}

Write-Host "`nDoing this: [STEP 1/5] Extracting project files..." -ForegroundColor Cyan
Write-Host "[PROGRESS] 25% (Stopping running containers...)"
Write-Host "`nStopping containers..." -ForegroundColor Cyan
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
if ($envFilePath -and (Test-Path $envFilePath)) {
    podman compose --env-file $envFilePath -f $composeFile -p $composeProject down 2>&1 | Out-Null
} else {
    podman compose -f $composeFile -p $composeProject down 2>&1 | Out-Null
}
$ErrorActionPreference = $prev
Write-Host "Containers stopped." -ForegroundColor Green

$zipFile = Join-Path $snapshotDir "project.zip"
if (Test-Path $zipFile) {
    Write-Host "[PROGRESS] 45% (Extracting project files...)"
    Write-Host "`nExtracting project files..." -ForegroundColor Cyan
    if (-not (Test-Path $Source)) { New-Item -ItemType Directory -Path $Source -Force | Out-Null }

    # Kill any running plink.exe processes to release file locks
    Write-Host "Releasing file locks by stopping plink.exe processes..." -ForegroundColor DarkGray
    Get-Process -Name plink -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1

    Expand-Archive -Path $zipFile -DestinationPath $Source -Force
    Write-Host "Files extracted." -ForegroundColor Green
} else {
    Write-Warning "project.zip not found, skipping file restore."
}

Write-Host "`nDoing this: [STEP 2/5] Restoring database dump..." -ForegroundColor Cyan
$sqlFile = Join-Path $snapshotDir "database.sql"
if (Test-Path $sqlFile) {
    Write-Host "[PROGRESS] 60% (Starting MySQL container...)"
    Write-Host "`nStarting MySQL for import..." -ForegroundColor Cyan
    $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    if ($envFilePath -and (Test-Path $envFilePath)) {
        podman compose --env-file $envFilePath -f $composeFile -p $composeProject up -d mysql 2>&1 | Out-Null
    } else {
        podman compose -f $composeFile -p $composeProject up -d mysql 2>&1 | Out-Null
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

    # $envVars has already been initialized and parsed early in the script.
    $dbPass = if ($envVars['MYSQL_ROOT_PASSWORD']) { $envVars['MYSQL_ROOT_PASSWORD'] } else { "" }
    $dbName = if ($envVars['MYSQL_DATABASE']) { $envVars['MYSQL_DATABASE'] } else { $Project }

    # Probe which client command works inside the container
    $clientCmd = "mariadb"
    $prevError = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    
    # Check if mariadb works
    podman exec $mysqlPod mariadb --version 2>$null | Out-Null
    $mariadbExit = $LASTEXITCODE
    
    # Check if mysql works
    podman exec $mysqlPod mysql --version 2>$null | Out-Null
    $mysqlExit = $LASTEXITCODE
    
    $ErrorActionPreference = $prevError

    if ($mariadbExit -eq 0) {
        $clientCmd = "mariadb"
    } elseif ($mysqlExit -eq 0) {
        $clientCmd = "mysql"
    } else {
        throw "Neither 'mariadb' nor 'mysql' database client binary was found or could be executed in container $mysqlPod."
    }

    Write-Host "[PROGRESS] 80% (Restoring database dump...)"
    Write-Host "Importing database..." -ForegroundColor Cyan
    Get-Content $sqlFile -Raw | podman exec -i $mysqlPod $clientCmd -uroot -p"$dbPass" $dbName 2>$null
    Write-Host "Database imported." -ForegroundColor Green

    $localUrl = if ($envVars['LOCAL_URL']) { $envVars['LOCAL_URL'] } else { "http://127.0.0.1:$($envVars['APP_HTTP_PORT'])" }
    "UPDATE wp_options SET option_value='$localUrl' WHERE option_name IN ('siteurl','home');" | podman exec -i $mysqlPod $clientCmd -uroot -p"$dbPass" $dbName 2>$null

    Write-Host "Stopping MySQL..." -ForegroundColor DarkGray
    $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    if ($envFilePath -and (Test-Path $envFilePath)) {
        podman compose --env-file $envFilePath -f $composeFile -p $composeProject down 2>&1 | Out-Null
    } else {
        podman compose -f $composeFile -p $composeProject down 2>&1 | Out-Null
    }
    $ErrorActionPreference = $prev
} else {
    Write-Host "No database.sql found, skipping database restore." -ForegroundColor Yellow
}

Write-Host "`nDoing this: [STEP 3/5] Regenerating local TLS certificates (if missing)..." -ForegroundColor Cyan
$certsDir = Join-Path $Source "nginx\edge\certs"
$certFile = Join-Path $certsDir "local.pem"
$keyFile = Join-Path $certsDir "local-key.pem"
if (-not (Test-Path $certFile) -or -not (Test-Path $keyFile)) {
    Write-Host "Local TLS certificates missing. Regenerating..." -ForegroundColor Yellow
    $tlsScript = Join-Path $Source "scripts\Install-LocalTls.ps1"
    if (Test-Path $tlsScript) {
        & $tlsScript
    } else {
        Write-Warning "scripts\Install-LocalTls.ps1 not found in restored files. Skipping TLS generation."
    }
} else {
    Write-Host "Local TLS certificates are already present." -ForegroundColor Green
}

Write-Host "`nDoing this: [STEP 4/5] Applying dynamic URL & SSL configuration overrides and patching script files..." -ForegroundColor Cyan

# Patch _Mypools-Root.ps1 for PowerShell 5.1 compatibility if it exists
$rootScript = Join-Path $Source "scripts\_Mypools-Root.ps1"
if (Test-Path $rootScript) {
    $scriptContent = Get-Content $rootScript -Raw
    $dirty = $false
    if ($scriptContent -match '\?\.Source') {
        Write-Host "Patching scripts\_Mypools-Root.ps1 for PowerShell 5.1 compatibility..." -ForegroundColor Yellow
        $scriptContent = $scriptContent -replace '\$sys\s*=\s*\(Get-Command pscp\s+-ErrorAction\s+SilentlyContinue\)\?\.Source\r?\n\s*if\s*\(\$sys\)\s*\{\s*return\s*\$sys\s*\}', '$sysCmd = Get-Command pscp -ErrorAction SilentlyContinue; if ($sysCmd) { return $sysCmd.Source }'
        $dirty = $true
    }
    if ($scriptContent -notmatch 'function Get-MypoolsPscpPath') {
        Write-Host "Appending Get-MypoolsPscpPath to scripts\_Mypools-Root.ps1..." -ForegroundColor Yellow
        $pscpFunc = "`r`n`r`nfunction Get-MypoolsPscpPath {`r`n    `$root = Get-MypoolsRoot`r`n    `$p = Join-Path `$root `"tools\pscp.exe`"`r`n    if (Test-Path `$p) { return `$p }`r`n    throw `"Missing `$p - add PuTTY pscp.exe under tools\`"`r`n}"
        $scriptContent += $pscpFunc
        $dirty = $true
    }
    if ($dirty) {
        Set-Content -Path $rootScript -Value $scriptContent -NoNewline
        Write-Host "scripts\_Mypools-Root.ps1 successfully updated." -ForegroundColor Green
    }
}

$wpConfigLocal = Join-Path $Source "secrets\wp-config.local.php"
if (Test-Path $wpConfigLocal) {
    $cfg = Get-Content $wpConfigLocal -Raw
    # Verify if our dynamic configuration block is already there
    if ($cfg -notmatch "Dynamic URL configuration for local") {
        Write-Host "Patching wp-config.local.php to support dynamic HTTP/HTTPS URL configurations..." -ForegroundColor Yellow
        
        # Remove any existing definitions to prevent double definition errors
        $cfg = $cfg -replace "define\(\s*'WP_HOME'\s*,.*?\);\r?\n?", ""
        $cfg = $cfg -replace "define\(\s*'WP_SITEURL'\s*,.*?\);\r?\n?", ""
        $cfg = $cfg -replace "define\(\s*'FORCE_SSL_ADMIN'\s*,.*?\);\r?\n?", ""
        
        $replacement = @"
// Dynamic URL configuration for local / LAN access supporting both HTTP and HTTPS edge proxy
`$is_https = (!empty(`$_SERVER['HTTPS']) && `$_SERVER['HTTPS'] !== 'off') || 
            (!empty(`$_SERVER['HTTP_X_FORWARDED_PROTO']) && `$_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https');

if (`$is_https) {
    define( 'WP_HOME', 'https://127.0.0.1:8443' );
    define( 'WP_SITEURL', 'https://127.0.0.1:8443' );
    define( 'FORCE_SSL_ADMIN', true );
} else {
    `$http_host = isset(`$_SERVER['HTTP_HOST']) ? `$_SERVER['HTTP_HOST'] : '127.0.0.1:9082';
    if (preg_match('/^[a-zA-Z0-9.:-]+$/', `$http_host)) {
        `$wp_home_url = 'http://' . `$http_host;
    } else {
        `$wp_home_url = 'http://127.0.0.1:9082';
    }
    define( 'WP_HOME', `$wp_home_url );
    define( 'WP_SITEURL', `$wp_home_url );
    define( 'FORCE_SSL_ADMIN', false );
}
"@
        if ($cfg -match "/\* Add any custom values between this line and the `"stop editing`" line\. \*/") {
            $cfg = $cfg -replace "(\r?\n)*(/\* Add any custom values between this line and the `"stop editing`" line\. \*/)", ("`r`n`r`n" + $replacement + "`r`n`r`n`$2")
        } else {
            $cfg = $cfg -replace "(\r?\n)*(/\* That's all, stop editing! Happy publishing\. \*/)", ("`r`n`r`n" + $replacement + "`r`n`r`n`$2")
        }
        Set-Content -Path $wpConfigLocal -Value $cfg -NoNewline
        Write-Host "wp-config.local.php successfully patched." -ForegroundColor Green
    } else {
        Write-Host "wp-config.local.php already has dynamic URL configuration." -ForegroundColor Green
    }
}

$muPluginDir = Join-Path $Source "wordpress\wp-content\mu-plugins"
if (-not (Test-Path $muPluginDir)) {
    New-Item -ItemType Directory -Path $muPluginDir -Force | Out-Null
}
$muPlugin = Join-Path $muPluginDir "mypools-dynamic-urls.php"

Write-Host "Updating mypools-dynamic-urls.php to include the dynamic host/port rewriter..." -ForegroundColor Yellow
$muContent = @"
<?php
/**
 * Plugin Name: MyPools Dynamic URLs (local / LAN)
 * Description: Serve CSS, images, and home_url() using the host the browser actually uses (127.0.0.1 or LAN IP).
 */

if (!defined('ABSPATH')) {
    exit;
}

/**
 * @return string|null Base URL for current HTTP request, or null to use database option.
 */
function mypools_request_base_url(): ?string
{
    if (php_sapi_name() === 'cli' || empty(`$_SERVER['HTTP_HOST'])) {
        return null;
    }

    `$scheme = (!empty(`$_SERVER['HTTPS']) && `$_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    `$host = sanitize_text_field(wp_unslash((string) `$_SERVER['HTTP_HOST']));

    return `$scheme . '://' . `$host;
}

function mypools_filter_home_option(`$pre, string `$option)
{
    `$base = mypools_request_base_url();
    return `$base ?? `$pre;
}
add_filter('pre_option_home', 'mypools_filter_home_option', 10, 2);
add_filter('pre_option_siteurl', 'mypools_filter_home_option', 10, 2);

/**
 * Rewrite production absolute URLs in media fields to the current host.
 */
function mypools_stale_url_prefixes(): array
{
    return [
        'http://127.0.0.1:9080',
        'https://127.0.0.1:9080',
        'http://localhost:9080',
        'https://localhost:9080',
        'http://127.0.0.1',
        'https://127.0.0.1',
        'http://localhost',
        'https://localhost',
        'https://mypools.co.za',
        'http://mypools.co.za',
        'https://www.mypools.co.za',
        'http://www.mypools.co.za',
    ];
}

function mypools_rewrite_to_request_host(string `$url): string
{
    `$url = trim(`$url);
    if (`$url === '') {
        return '';
    }

    `$base = mypools_request_base_url();
    if (`$base === null) {
        return `$url;
    }

    // Only rewrite absolute URLs starting with http/https
    if (!preg_match('#^https?://([^/]+)(.*)$#i', `$url, `$matches)) {
        return `$url;
    }

    `$url_host_with_port = `$matches[1];
    `$url_path = `$matches[2];

    // Split host from port (if any)
    `$parts = explode(':', `$url_host_with_port, 2);
    `$url_host = strtolower(`$parts[0]);

    `$should_rewrite = false;

    // Check if the host matches production domain, local addresses, or private LAN patterns
    if (in_array(`$url_host, ['mypools.co.za', 'www.mypools.co.za', 'localhost', '127.0.0.1'], true)) {
        `$should_rewrite = true;
    } elseif (
        str_starts_with(`$url_host, '192.168.') ||
        str_starts_with(`$url_host, '10.') ||
        preg_match('/^172\.(1[6-9]|2[0-9]|3[0-1])\./', `$url_host)
    ) {
        `$should_rewrite = true;
    }

    if (`$should_rewrite) {
        return `$base . `$url_path;
    }

    return `$url;
}

function mypools_localize_media_url(string `$url): string
{
    return mypools_rewrite_to_request_host(trim(`$url));
}

function mypools_rewrite_srcset_string(string `$srcset): string
{
    if (`$srcset === '') {
        return '';
    }

    `$parts = array_map('trim', explode(',', `$srcset));
    `$rewritten = [];

    foreach (`$parts as `$part) {
        if (`$part === '') {
            continue;
        }
        `$tokens = preg_split('/\s+/', `$part, 2);
        if (!`$tokens) {
            continue;
        }
        `$tokens[0] = mypools_rewrite_to_request_host(`$tokens[0]);
        `$rewritten[] = implode(' ', `$tokens);
    }

    return implode(', ', `$rewritten);
}

function mypools_localize_home_screen_settings(array `$settings): array
{
    foreach (['logo', 'hero_image', 'pool_owners_destination', 'contractors_destination'] as `$key) {
        if (!empty(`$settings[`$key])) {
            `$settings[`$key] = mypools_localize_media_url((string) `$settings[`$key]);
        }
    }

    if (!empty(`$settings['datasets']) && is_array(`$settings['datasets'])) {
        foreach (`$settings['datasets'] as `$i => `$dataset) {
            if (!empty(`$dataset['image'])) {
                `$settings['datasets'][`$i]['image'] = mypools_localize_media_url((string) `$dataset['image']);
            }
        }
    }

    return `$settings;
}
add_filter('option_mypools_home_screen_settings', 'mypools_localize_home_screen_settings');

function mypools_rewrite_asset_src(string `$src): string
{
    return mypools_rewrite_to_request_host(`$src);
}
add_filter('style_loader_src', 'mypools_rewrite_asset_src');
add_filter('script_loader_src', 'mypools_rewrite_asset_src');
add_filter('wp_get_attachment_url', 'mypools_rewrite_asset_src');
add_filter('wp_calculate_image_srcset', 'mypools_rewrite_attachment_srcset', 10, 5);
add_filter('wp_get_attachment_image_attributes', 'mypools_rewrite_attachment_image_attributes', 10, 3);
add_filter('wp_content_img_tag', 'mypools_rewrite_content_img_tag', 10, 3);

function mypools_rewrite_attachment_srcset(`$sources, `$size_array, `$image_src, `$image_meta, `$attachment_id)
{
    if (!is_array(`$sources)) {
        return `$sources;
    }

    foreach (`$sources as `$width => `$source) {
        if (isset(`$source['url'])) {
            `$sources[`$width]['url'] = mypools_rewrite_to_request_host((string) `$source['url']);
        }
    }

    return `$sources;
}

function mypools_rewrite_attachment_image_attributes(array `$attr, `$attachment, `$size): array
{
    if (!empty(`$attr['src'])) {
        `$attr['src'] = mypools_rewrite_to_request_host((string) `$attr['src']);
    }

    if (!empty(`$attr['srcset'])) {
        `$attr['srcset'] = mypools_rewrite_srcset_string((string) `$attr['srcset']);
    }

    if (!empty(`$attr['sizes']) && str_contains((string) `$attr['sizes'], 'auto')) {
        `$attr['sizes'] = '(max-width: 720px) 100vw, (max-width: 1200px) 50vw, 33vw';
    }

    return `$attr;
}

function mypools_rewrite_content_img_tag(string `$html, string `$context, int `$attachment_id): string
{
    return preg_replace_callback(
        '#https?://[^"\'\s>]+#',
        static function (array `$matches): string {
            return mypools_rewrite_to_request_host(`$matches[0]);
        },
        `$html
    ) ?? `$html;
}
"@
Set-Content -Path $muPlugin -Value $muContent -NoNewline
Write-Host "mypools-dynamic-urls.php successfully updated." -ForegroundColor Green

Write-Host "`nDoing this: [STEP 5/5] Spinning up containers & verifying stack health..." -ForegroundColor Cyan
Write-Host "[PROGRESS] 90% (Starting all application containers...)"
Write-Host "`nStarting full stack..." -ForegroundColor Cyan
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
if ($envFilePath -and (Test-Path $envFilePath)) {
    podman compose --env-file $envFilePath -f $composeFile -p $composeProject up -d 2>&1 | Out-Null
} else {
    podman compose -f $composeFile -p $composeProject up -d 2>&1 | Out-Null
}
$ErrorActionPreference = $prev

Write-Host "Waiting for containers to initialize and report health..." -ForegroundColor Yellow
Start-Sleep -Seconds 5

$containers = @("mysql", "redis", "php", "nginx")
$allHealthy = $true

foreach ($svc in $containers) {
    # Find container name for this service
    $cName = @(podman ps --filter "label=io.podman.compose.project=$composeProject" --filter "label=io.podman.compose.service=$svc" --format "{{.Names}}" | Select-Object -First 1)
    if (-not $cName) {
        $cName = "mypools-local_$($svc)_1"
    }
    
    Write-Host "Checking service '$svc' ($cName)... " -NoNewline
    
    $status = "unknown"
    for ($attempt = 1; $attempt -le 15; $attempt++) {
        $inspect = podman inspect $cName 2>$null | ConvertFrom-Json
        if ($inspect) {
            $state = $inspect[0].State
            if ($state.Health) {
                $status = $state.Health.Status
                if ($status -eq "healthy") { break }
            } else {
                $status = if ($state.Running) { "running" } else { "stopped" }
                if ($status -eq "running") { break }
            }
        }
        Start-Sleep -Seconds 2
    }
    
    if ($status -eq "healthy" -or $status -eq "running") {
        Write-Host "$status" -ForegroundColor Green
    } else {
        Write-Host "$status" -ForegroundColor Red
        $allHealthy = $false
    }
}

$appPort = if ($envVars['APP_HTTP_PORT']) { $envVars['APP_HTTP_PORT'] } else { "9080" }
$testUrl = "http://127.0.0.1:$appPort/"
Write-Host "Verifying HTTP connectivity on $testUrl..." -ForegroundColor Yellow

$httpCode = 0
try {
    $resp = curl.exe -s -o NUL -w "%{http_code}" --max-time 10 $testUrl
    $httpCode = [int]$resp
} catch {
    Write-Host "HTTP request failed: $_" -ForegroundColor Red
}

if ($httpCode -ge 200 -and $httpCode -lt 400) {
    Write-Host "HTTP Health Check: SUCCESS (Status Code: $httpCode)" -ForegroundColor Green
} else {
    Write-Host "HTTP Health Check: FAILED (Status Code: $httpCode)" -ForegroundColor Red
    $allHealthy = $false
}

$running = @(podman ps --filter "label=io.podman.compose.project=$composeProject" --format "{{.Names}}" 2>$null)
Write-Host "[PROGRESS] 100% (Restore complete)"

if ($allHealthy) {
    Write-Host "`n[Recovery State Completed...]" -ForegroundColor Green
    Write-Host "Running: $($running -join ', ')" -ForegroundColor Green
    Write-Host "URL: http://127.0.0.1:$($envVars['APP_HTTP_PORT'])/" -ForegroundColor Cyan
} else {
    Write-Warning "`n[Recovery State Completed with warnings...]"
    Write-Host "Some services did not pass health verification. Verify container logs." -ForegroundColor Red
    Write-Host "Running: $($running -join ', ')" -ForegroundColor Green
    Write-Host "URL: http://127.0.0.1:$($envVars['APP_HTTP_PORT'])/" -ForegroundColor Cyan
}
