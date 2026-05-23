const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const url = require('url');
const crypto = require('crypto');
const os = require('os');

const PORT = 3050;
const SNAPSHOTS_ROOT = 'C:\\snapshots';
const PROJECTS_FILE = path.join(SNAPSHOTS_ROOT, 'projects.json');

function loadProjects() {
  if (!fs.existsSync(PROJECTS_FILE)) {
    const defaultProjects = [
      { name: 'mypools', path: 'C:\\Podman\\MyPools' }
    ];
    try {
      fs.mkdirSync(SNAPSHOTS_ROOT, { recursive: true });
      fs.writeFileSync(PROJECTS_FILE, JSON.stringify(defaultProjects, null, 2), 'utf8');
    } catch(e) {}
    return defaultProjects;
  }
  try {
    return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    console.error('Failed to parse projects.json', e);
    return [];
  }
}

function saveProjects(projects) {
  try {
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to write projects.json', e);
  }
}

function getProjectPath(projectName) {
  const projs = loadProjects();
  const proj = projs.find(p => p.name.toLowerCase() === projectName.toLowerCase());
  return proj ? proj.path : null;
}

function getComposeProjectName(projectPath, defaultName) {
  try {
    const envFile = fs.existsSync(path.join(projectPath, '.env.local'))
      ? path.join(projectPath, '.env.local')
      : (fs.existsSync(path.join(projectPath, '.env')) ? path.join(projectPath, '.env') : null);
    if (envFile) {
      const lines = fs.readFileSync(envFile, 'utf8').split('\n');
      for (const line of lines) {
        if (line.trim().startsWith('COMPOSE_PROJECT_NAME=')) {
          return line.split('=')[1].trim().replace(/['"]/g, '');
        }
      }
    }
  } catch (e) {}
  return defaultName;
}

// Global state for running tasks
let activeTask = {
  status: 'idle', // 'idle' | 'running'
  type: null,     // 'create' | 'restore'
  project: null
};
let logBuffer = [];
let stdoutAccumulator = '';
let stderrAccumulator = '';
const sseClients = new Set();

// Utility: Broadcast a message to all connected SSE clients
function broadcast(message) {
  const rawMsg = `data: ${JSON.stringify(message)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(rawMsg);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

// Utility: Append line to log buffer and broadcast
function appendAndBroadcastLog(text, stream) {
  const logEntry = { type: 'log', text, stream, time: new Date().toISOString() };
  logBuffer.push(logEntry);
  if (logBuffer.length > 2000) {
    logBuffer.shift();
  }
  broadcast(logEntry);
}

// Process data chunks into lines
function processLogChunk(chunk, stream) {
  if (stream === 'stdout') {
    stdoutAccumulator += chunk;
    const lines = stdoutAccumulator.split('\n');
    stdoutAccumulator = lines.pop();
    for (const line of lines) {
      appendAndBroadcastLog(line + '\n', stream);
    }
  } else {
    stderrAccumulator += chunk;
    const lines = stderrAccumulator.split('\n');
    stderrAccumulator = lines.pop();
    for (const line of lines) {
      appendAndBroadcastLog(line + '\n', stream);
    }
  }
}

// Helper to fetch URL with options (e.g. timeout, headers, ssl options)
const fetchUrl = (targetUrl, options = {}) => {
  return new Promise((resolve) => {
    const start = Date.now();
    const lib = targetUrl.startsWith('https') ? require('https') : require('http');
    
    const reqOptions = {
      headers: { 'User-Agent': 'Snapshot-Console-Health-Checker', ...(options.headers || {}) },
      rejectUnauthorized: false, // Bypass SSL verification for self-signed certificates
      ...options
    };

    const req = lib.get(targetUrl, reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          responseTime: Date.now() - start,
          headers: res.headers,
          body: data
        });
      });
    });
    
    req.on('error', (err) => {
      resolve({
        status: 0,
        responseTime: Date.now() - start,
        error: err.message,
        body: ''
      });
    });
    
    const timeoutVal = options.timeout || 8000;
    req.setTimeout(timeoutVal, () => {
      req.destroy();
      resolve({
        status: 0,
        responseTime: Date.now() - start,
        error: 'Timeout',
        body: ''
      });
    });
  });
};

// Helper to query WordPress siteurl from Database
function getWordPressUrlFromDb(mysqlContainer, dbUser, dbPassword, dbName) {
  return new Promise((resolve) => {
    if (!mysqlContainer) {
      resolve({ ok: false, error: 'MySQL container is not running or not found' });
      return;
    }
    const user = dbUser || 'mypools';
    const pass = dbPassword || 'local-mypools';
    const db = dbName || 'mypools';

    const tryCmd = (client, fallback) => {
      const cmd = `podman exec -i ${mysqlContainer} ${client} -u"${user}" -p"${pass}" -D "${db}" -se "SELECT option_value FROM wp_options WHERE option_name = 'siteurl' LIMIT 1;"`;
      exec(cmd, { timeout: 5000 }, (err, stdout, stderr) => {
        if (err) {
          const errMsg = (stderr || err.message || '').trim();
          if (fallback && (errMsg.includes('not found') || errMsg.includes('executable file'))) {
            tryCmd(fallback, null);
          } else {
            resolve({ ok: false, error: `Database query failed: ${errMsg || 'Unknown error'}` });
          }
        } else {
          const val = stdout.trim();
          if (val) {
            resolve({ ok: true, url: val });
          } else {
            resolve({ ok: false, error: "Database query succeeded but 'siteurl' option is empty or missing in wp_options table" });
          }
        }
      });
    };

    tryCmd('mariadb', 'mysql');
  });
}

// Helper to fetch URL following redirects and preserving local port mappings
async function fetchWithRedirects(targetUrl, options = {}, maxRedirects = 3) {
  let currentUrl = targetUrl;
  let redirectsFollowed = 0;
  
  while (redirectsFollowed <= maxRedirects) {
    const res = await fetchUrl(currentUrl, options);
    if (res.status === 200) {
      return { ok: true, status: 200, url: currentUrl, responseTime: res.responseTime, res };
    }
    
    if ((res.status === 301 || res.status === 302 || res.status === 307 || res.status === 308) && res.headers && res.headers.location) {
      let nextUrl = res.headers.location;
      
      // If it's a relative URL, resolve it relative to currentUrl
      if (nextUrl.startsWith('/')) {
        try {
          const parsedCurrent = new URL(currentUrl);
          nextUrl = `${parsedCurrent.protocol}//${parsedCurrent.host}${nextUrl}`;
        } catch (e) {
          return { ok: false, status: res.status, url: currentUrl, error: `Invalid redirect path: ${nextUrl}`, res };
        }
      } else if (!nextUrl.startsWith('http://') && !nextUrl.startsWith('https://')) {
        try {
          const parsedCurrent = new URL(currentUrl);
          nextUrl = `${parsedCurrent.protocol}//${parsedCurrent.host}/${nextUrl}`;
        } catch (e) {
          return { ok: false, status: res.status, url: currentUrl, error: `Invalid redirect path: ${nextUrl}`, res };
        }
      }
      
      // Ensure the redirect URL preserves/injects correct local mapped ports
      try {
        const nextParsed = new URL(nextUrl);
        if (!nextParsed.port) {
          if (nextParsed.protocol === 'https:') {
            nextParsed.port = options.edgePort || '8443';
          } else if (nextParsed.protocol === 'http:') {
            nextParsed.port = options.httpPort || '9080';
          }
          nextUrl = nextParsed.toString();
        }
      } catch (e) {}

      currentUrl = nextUrl;
      redirectsFollowed++;
    } else {
      return { ok: false, status: res.status, url: currentUrl, error: res.error || `HTTP Status Code: ${res.status}`, res };
    }
  }
  
  return { ok: false, status: 0, url: currentUrl, error: 'Too many redirects' };
}

// Verification helper for WordPress Connection
async function verifyWordPress(httpPort, edgePort, mysqlContainer, dbUser, dbPassword, dbName) {
  if (!mysqlContainer) {
    return {
      ok: false,
      status: 0,
      url: 'Database Option: siteurl',
      error: 'MySQL container is not running or not found',
      dbRetrieved: false
    };
  }

  const dbRes = await getWordPressUrlFromDb(mysqlContainer, dbUser, dbPassword, dbName);
  if (!dbRes.ok) {
    return {
      ok: false,
      status: 0,
      url: 'Database Option: siteurl',
      error: `Failed to retrieve WordPress URL from database: ${dbRes.error}`,
      dbRetrieved: false
    };
  }

  const siteUrlVal = dbRes.url;
  let checkUrl;
  try {
    const parsed = new URL(siteUrlVal);
    const protocol = parsed.protocol || 'https:';
    const hostname = parsed.hostname || '127.0.0.1';
    const port = (protocol === 'https:') ? edgePort : httpPort;
    checkUrl = `${protocol}//${hostname}:${port}/wp-login.php`;
  } catch (e) {
    return {
      ok: false,
      status: 0,
      url: siteUrlVal || 'Invalid URL',
      error: `Failed to parse siteurl from database: ${e.message}`,
      dbRetrieved: true,
      siteUrlFromDb: siteUrlVal
    };
  }

  // Perform check using fetchWithRedirects
  const checkResult = await fetchWithRedirects(checkUrl, {
    timeout: 5000,
    edgePort,
    httpPort
  });

  if (checkResult.ok) {
    return {
      ok: true,
      status: 200,
      url: checkResult.url,
      responseTime: checkResult.responseTime,
      dbRetrieved: true,
      siteUrlFromDb: siteUrlVal
    };
  }

  return {
    ok: false,
    status: checkResult.status || 0,
    url: checkUrl,
    error: checkResult.error || `HTTP Status Code: ${checkResult.status}`,
    dbRetrieved: true,
    siteUrlFromDb: siteUrlVal
  };
}

// Verification helper for MyPools Homescreen Connection
async function verifyHomescreen(httpPort, edgePort, mysqlContainer, dbUser, dbPassword, dbName) {
  if (!mysqlContainer) {
    return {
      ok: false,
      status: 0,
      url: 'Database Option: siteurl (for domain)',
      error: 'MySQL container is not running or not found',
      dbRetrieved: false
    };
  }

  const dbRes = await getWordPressUrlFromDb(mysqlContainer, dbUser, dbPassword, dbName);
  if (!dbRes.ok) {
    return {
      ok: false,
      status: 0,
      url: 'Database Option: siteurl (for domain)',
      error: `Failed to retrieve siteurl from database: ${dbRes.error}`,
      dbRetrieved: false
    };
  }

  const siteUrlVal = dbRes.url;
  let hostname;
  try {
    const parsed = new URL(siteUrlVal);
    hostname = parsed.hostname;
    if (!hostname) {
      throw new Error('No hostname in siteurl');
    }
  } catch (e) {
    return {
      ok: false,
      status: 0,
      url: siteUrlVal || 'Invalid URL',
      error: `Failed to parse hostname from database siteurl: ${e.message}`,
      dbRetrieved: true
    };
  }

  // Try HTTP on httpPort first
  const httpUrl = `http://${hostname}:${httpPort}/`;
  const httpRes = await fetchWithRedirects(httpUrl, { timeout: 5000, edgePort, httpPort });
  if (httpRes.ok) {
    return { ok: true, status: 200, url: httpRes.url, responseTime: httpRes.responseTime, dbRetrieved: true };
  }

  // Try HTTPS edge as fallback
  const httpsUrl = `https://${hostname}:${edgePort}/`;
  const httpsRes = await fetchWithRedirects(httpsUrl, { timeout: 5000, edgePort, httpPort });
  if (httpsRes.ok) {
    return { ok: true, status: 200, url: httpsRes.url, responseTime: httpsRes.responseTime, dbRetrieved: true };
  }

  // Choose the best error message to return
  const errMessage = httpRes.error || httpsRes.error || `HTTP Status Code: ${httpRes.status || httpsRes.status}`;
  return {
    ok: false,
    status: httpRes.status || httpsRes.status,
    url: httpUrl,
    error: `Homescreen check failed. Primary (HTTP): ${httpRes.error || 'status ' + httpRes.status}. Fallback (HTTPS): ${httpsRes.error || 'status ' + httpsRes.status}`,
    dbRetrieved: true
  };
}

// Helper to query WordPress database for legacy 9082 URLs
function checkLegacyUrlsInDb(mysqlContainer, dbUser, dbPassword, dbName) {
  return new Promise((resolve) => {
    if (!mysqlContainer) {
      resolve({ ok: false, error: 'MySQL container is not running or not found', postsCount: 0, metaCount: 0 });
      return;
    }
    const user = dbUser || 'mypools';
    const pass = dbPassword || 'local-mypools';
    const db = dbName || 'mypools';

    const tryCmd = (client, fallback) => {
      const sql = "SELECT COUNT(*) FROM wp_posts WHERE guid LIKE '%:9082%'; SELECT COUNT(*) FROM wp_postmeta WHERE meta_value LIKE '%:9082%';";
      const cmd = `podman exec -i ${mysqlContainer} ${client} -u"${user}" -p"${pass}" -D "${db}" -se "${sql}"`;
      exec(cmd, { timeout: 5000 }, (err, stdout, stderr) => {
        if (err) {
          const errMsg = (stderr || err.message || '').trim();
          if (fallback && (errMsg.includes('not found') || errMsg.includes('executable file'))) {
            tryCmd(fallback, null);
          } else {
            resolve({ ok: false, error: `Database query failed: ${errMsg || 'Unknown error'}`, postsCount: 0, metaCount: 0 });
          }
        } else {
          const val = stdout.trim();
          if (val) {
            const lines = val.split(/[\\r\\n]+/).map(l => parseInt(l.trim(), 10) || 0);
            resolve({ ok: true, postsCount: lines[0] || 0, metaCount: lines[1] || 0 });
          } else {
            resolve({ ok: true, postsCount: 0, metaCount: 0 });
          }
        }
      });
    };

    tryCmd('mariadb', 'mysql');
  });
}

// Helper to inspect WordPress mu-plugins for dynamic and canonical URL filter files
function checkMuPlugins(projectPath) {
  const muDir = path.join(projectPath, 'wordpress', 'wp-content', 'mu-plugins');
  const dynamicPath = path.join(muDir, 'mypools-dynamic-urls.php');
  const canonicalPath = path.join(muDir, 'mypools-canonical-urls.php');

  const res = {
    dynamicExists: false,
    canonicalExists: false,
    dynamicHasFilters: false,
    canonicalHasFilters: false
  };

  if (fs.existsSync(dynamicPath)) {
    res.dynamicExists = true;
    try {
      const content = fs.readFileSync(dynamicPath, 'utf8');
      res.dynamicHasFilters = content.includes('mypools_filter_upload_dir');
    } catch (e) {}
  }
  
  if (fs.existsSync(canonicalPath)) {
    res.canonicalExists = true;
    try {
      const content = fs.readFileSync(canonicalPath, 'utf8');
      res.canonicalHasFilters = content.includes('mypools_canonicalize_upload_dir');
    } catch (e) {}
  }

  return res;
}

// Verification helper for WordPress Media Library & Thumbnails
async function verifyMediaThumbnails(projectPath, mysqlContainer, dbUser, dbPassword, dbName) {
  const muCheck = checkMuPlugins(projectPath);
  
  if (!mysqlContainer) {
    return {
      ok: false,
      status: 'error',
      message: 'MySQL container is not running or not found',
      muCheck,
      dbCheck: { ok: false, postsCount: 0, metaCount: 0 }
    };
  }

  const dbCheck = await checkLegacyUrlsInDb(mysqlContainer, dbUser, dbPassword, dbName);
  
  const hasLegacyUrls = dbCheck.ok && (dbCheck.postsCount > 0 || dbCheck.metaCount > 0);
  const muMissingFilters = !muCheck.dynamicHasFilters || !muCheck.canonicalHasFilters;
  
  const ok = !hasLegacyUrls && !muMissingFilters && muCheck.dynamicExists && muCheck.canonicalExists;

  let message = 'All media URL filters are active, and no legacy references remain in the database.';
  if (!muCheck.dynamicExists || !muCheck.canonicalExists) {
    message = 'Required mu-plugins for dynamic and canonical URLs are missing.';
  } else if (muMissingFilters) {
    message = 'WordPress mu-plugins are missing the media library and thumbnail filters.';
  } else if (hasLegacyUrls) {
    message = `Found ${dbCheck.postsCount} legacy GUIDs and ${dbCheck.metaCount} postmeta values with port 9082.`;
  }

  return {
    ok,
    status: ok ? 'ok' : 'warning',
    message,
    muCheck,
    dbCheck
  };
}

// Helper to write the complete mu-plugins with updated filters
function writeMuPlugins(muDir) {
  const dynamicContent = `<?php
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
    if (php_sapi_name() === 'cli' || empty($_SERVER['HTTP_HOST'])) {
        return null;
    }

    $is_https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (
            !empty($_SERVER['HTTP_X_FORWARDED_PROTO'])
            && 'https' === strtolower((string) $_SERVER['HTTP_X_FORWARDED_PROTO'])
        );
    $scheme = $is_https ? 'https' : 'http';
    $host = sanitize_text_field(wp_unslash((string) $_SERVER['HTTP_HOST']));

    return $scheme . '://' . $host;
}

function mypools_filter_home_option($pre, string $option)
{
    $base = mypools_request_base_url();
    return $base ?? $pre;
}
add_filter('pre_option_home', 'mypools_filter_home_option', 10, 2);
add_filter('pre_option_siteurl', 'mypools_filter_home_option', 10, 2);

/**
 * Rewrite production absolute URLs in media fields to the current host.
 */
/**
 * Host prefixes stored in the DB or baked at plugin load — rewrite to the current request host.
 */
function mypools_stale_url_prefixes(): array
{
    return [
        // Legacy SSH tunnel port — normalize to current home_url()
        'http://127.0.0.1:9082',
        'https://127.0.0.1:9082',
        'http://localhost:9082',
        'https://localhost:9082',
        'http://127.0.0.1:9080',
        'https://127.0.0.1:9080',
        'http://localhost:9080',
        'https://localhost:9080',
        'http://127.0.0.1:9081',
        'https://127.0.0.1:9081',
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

/**
 * Canonical public base (matches home_url() for the active request).
 */
function mypools_media_base_url(): string
{
    return untrailingslashit(home_url());
}

function mypools_rewrite_to_request_host(string $url): string
{
    $url = trim($url);
    if ($url === '') {
        return '';
    }

    $base = mypools_media_base_url();
    if ($base === '') {
        return $url;
    }

    foreach (mypools_stale_url_prefixes() as $prefix) {
        if (str_starts_with($url, $prefix)) {
            $prefix_len = strlen($prefix);
            $next_char = substr($url, $prefix_len, 1);
            if ($next_char === '' || $next_char === '/') {
                return $base . substr($url, $prefix_len);
            }
        }
    }

    return $url;
}

if (!function_exists('mypools_localize_media_url')) {
    function mypools_localize_media_url(string $url): string
    {
        return mypools_rewrite_to_request_host(trim($url));
    }
}

function mypools_rewrite_srcset_string(string $srcset): string
{
    if ($srcset === '') {
        return '';
    }

    $parts = array_map('trim', explode(',', $srcset));
    $rewritten = [];

    foreach ($parts as $part) {
        if ($part === '') {
            continue;
        }
        $tokens = preg_split('/\\\\s+/', $part, 2);
        if (!$tokens) {
            continue;
        }
        $tokens[0] = mypools_rewrite_to_request_host($tokens[0]);
        $rewritten[] = implode(' ', $tokens);
    }

    return implode(', ', $rewritten);
}

function mypools_localize_home_screen_settings(array $settings): array
{
    foreach (['logo', 'hero_image', 'pool_owners_destination', 'contractors_destination'] as $key) {
        if (!empty($settings[$key])) {
            $settings[$key] = mypools_localize_media_url((string) $settings[$key]);
        }
    }

    if (!empty($settings['datasets']) && is_array($settings['datasets'])) {
        foreach ($settings['datasets'] as $i => $dataset) {
            if (!empty($dataset['image'])) {
                $settings['datasets'][$i]['image'] = mypools_localize_media_url((string) $dataset['image']);
            }
        }
    }

    return $settings;
}
add_filter('option_mypools_home_screen_settings', 'mypools_localize_home_screen_settings');

function mypools_rewrite_asset_src(string $src): string
{
    return mypools_rewrite_to_request_host($src);
}
add_filter('style_loader_src', 'mypools_rewrite_asset_src');
add_filter('script_loader_src', 'mypools_rewrite_asset_src');
add_filter('wp_get_attachment_url', 'mypools_rewrite_asset_src');
add_filter('wp_get_attachment_thumb_url', 'mypools_rewrite_asset_src');

function mypools_filter_upload_dir(array $uploads): array
{
    if (isset($uploads['url'])) {
        $uploads['url'] = mypools_rewrite_to_request_host($uploads['url']);
    }
    if (isset($uploads['baseurl'])) {
        $uploads['baseurl'] = mypools_rewrite_to_request_host($uploads['baseurl']);
    }
    return $uploads;
}
add_filter('upload_dir', 'mypools_filter_upload_dir', 10);

function mypools_rewrite_attachment_image_src($image, $attachment_id, $size, $icon)
{
    if (is_array($image) && isset($image[0])) {
        $image[0] = mypools_rewrite_to_request_host($image[0]);
    }
    return $image;
}
add_filter('wp_get_attachment_image_src', 'mypools_rewrite_attachment_image_src', 10, 4);

function mypools_filter_custom_postmeta($value, $object_id, $meta_key, $single, $meta_type = 'post')
{
    if ($meta_type !== 'post') {
        return $value;
    }
    if (in_array($meta_key, ['_mypools_logo', '_mypools_hero_image'], true)) {
        remove_filter('get_post_metadata', 'mypools_filter_custom_postmeta', 10);
        $val = get_post_meta($object_id, $meta_key, $single);
        add_filter('get_post_metadata', 'mypools_filter_custom_postmeta', 10, 5);

        if (is_string($val) && $val !== '') {
            return mypools_rewrite_to_request_host($val);
        } elseif (is_array($val)) {
            return array_map(function ($item) {
                return is_string($item) ? mypools_rewrite_to_request_host($item) : $item;
            }, $val);
        }
    }
    return $value;
}
add_filter('get_post_metadata', 'mypools_filter_custom_postmeta', 10, 5);

add_filter('wp_calculate_image_srcset', 'mypools_rewrite_attachment_srcset', 10, 5);
add_filter('wp_get_attachment_image_attributes', 'mypools_rewrite_attachment_image_attributes', 10, 3);
add_filter('wp_content_img_tag', 'mypools_rewrite_content_img_tag', 10, 3);
`;

  const canonicalContent = `<?php
/**
 * Plugin Name: MyPools Canonical URLs (local)
 * Description: Rewrite legacy absolute URLs in stored content to WP_HOME (https://mypools.test). No per-request host mutation.
 */

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Legacy URL prefixes from production imports or old local port/IP access.
 */
function mypools_legacy_url_prefixes(): array
{
    return [
        'http://127.0.0.1:9082',
        'https://127.0.0.1:9082',
        'http://localhost:9082',
        'https://localhost:9082',
        'http://127.0.0.1:9080',
        'https://127.0.0.1:9080',
        'http://localhost:9080',
        'https://localhost:9080',
        'http://127.0.0.1:9081',
        'https://127.0.0.1:9081',
        'http://127.0.0.1:8443',
        'https://127.0.0.1:8443',
        'http://127.0.0.1',
        'https://127.0.0.1',
        'http://localhost',
        'https://localhost',
        'http://mypools.local',
        'https://mypools.local',
        'http://mypools.test',
        'https://mypools.test',
        'https://mypools.co.za',
        'http://mypools.co.za',
        'https://www.mypools.co.za',
        'http://www.mypools.co.za',
    ];
}

function mypools_canonical_base_url(): string
{
    if (defined('WP_HOME') && is_string(WP_HOME) && WP_HOME !== '') {
        return untrailingslashit(WP_HOME);
    }

    return untrailingslashit(home_url());
}

function mypools_canonicalize_url(string $url): string
{
    $url = trim($url);
    if ($url === '') {
        return '';
    }

    $base = mypools_canonical_base_url();
    if ($base === '') {
        return $url;
    }

    foreach (mypools_legacy_url_prefixes() as $prefix) {
        if (!str_starts_with($url, $prefix)) {
            continue;
        }
        $prefix_len = strlen($prefix);
        $next_char = substr($url, $prefix_len, 1);
        if ($next_char === '' || $next_char === '/') {
            return $base . substr($url, $prefix_len);
        }
    }

    return $url;
}

function mypools_canonicalize_home_screen_settings(array $settings): array
{
    foreach (['logo', 'hero_image', 'pool_owners_destination', 'contractors_destination'] as $key) {
        if (!empty($settings[$key])) {
            $settings[$key] = mypools_canonicalize_url((string) $settings[$key]);
        }
    }

    if (!empty($settings['datasets']) && is_array($settings['datasets'])) {
        foreach ($settings['datasets'] as $i => $dataset) {
            if (!empty($dataset['image'])) {
                $settings['datasets'][$i]['image'] = mypools_canonicalize_url((string) $dataset['image']);
            }
        }
    }

    return $settings;
}
add_filter('option_mypools_home_screen_settings', 'mypools_canonicalize_home_screen_settings');

function mypools_canonicalize_asset_src(string $src): string
{
    return mypools_canonicalize_url($src);
}
add_filter('style_loader_src', 'mypools_canonicalize_asset_src');
add_filter('script_loader_src', 'mypools_canonicalize_asset_src');
add_filter('wp_get_attachment_url', 'mypools_canonicalize_asset_src');
add_filter('wp_get_attachment_thumb_url', 'mypools_canonicalize_asset_src');

function mypools_canonicalize_upload_dir(array $uploads): array
{
    if (isset($uploads['url'])) {
        $uploads['url'] = mypools_canonicalize_url($uploads['url']);
    }
    if (isset($uploads['baseurl'])) {
        $uploads['baseurl'] = mypools_canonicalize_url($uploads['baseurl']);
    }
    return $uploads;
}
add_filter('upload_dir', 'mypools_canonicalize_upload_dir', 10);

function mypools_canonicalize_attachment_image_src($image, $attachment_id, $size, $icon)
{
    if (is_array($image) && isset($image[0])) {
        $image[0] = mypools_canonicalize_url($image[0]);
    }
    return $image;
}
add_filter('wp_get_attachment_image_src', 'mypools_canonicalize_attachment_image_src', 10, 4);

function mypools_canonicalize_custom_postmeta($value, $object_id, $meta_key, $single, $meta_type = 'post')
{
    if ($meta_type !== 'post') {
        return $value;
    }
    if (in_array($meta_key, ['_mypools_logo', '_mypools_hero_image'], true)) {
        remove_filter('get_post_metadata', 'mypools_canonicalize_custom_postmeta', 10);
        $val = get_post_meta($object_id, $meta_key, $single);
        add_filter('get_post_metadata', 'mypools_canonicalize_custom_postmeta', 10, 5);

        if (is_string($val) && $val !== '') {
            return mypools_canonicalize_url($val);
        } elseif (is_array($val)) {
            return array_map(function ($item) {
                return is_string($item) ? mypools_canonicalize_url($item) : $item;
            }, $val);
        }
    }
    return $value;
}
add_filter('get_post_metadata', 'mypools_canonicalize_custom_postmeta', 10, 5);

/** @deprecated Use mypools_canonicalize_url */
if (!function_exists('mypools_localize_media_url')) {
    function mypools_localize_media_url(string $url): string
    {
        return mypools_canonicalize_url($url);
    }
}
`;

  fs.writeFileSync(path.join(muDir, 'mypools-dynamic-urls.php'), dynamicContent, 'utf8');
  fs.writeFileSync(path.join(muDir, 'mypools-canonical-urls.php'), canonicalContent, 'utf8');
}

// Run a PowerShell script in a child process
function runPowerShellScript(scriptFile, args) {
  if (activeTask.status === 'running') {
    throw new Error('Another task is already running');
  }

  activeTask.status = 'running';
  const isCreate = scriptFile.toLowerCase().includes('create');
  const isRestore = scriptFile.toLowerCase().includes('restore');
  activeTask.type = isCreate ? 'create' : (isRestore ? 'restore' : 'deploy');
  
  // Find project argument
  const projIdx = args.indexOf('-Project');
  activeTask.project = projIdx !== -1 ? args[projIdx + 1] : (activeTask.type === 'deploy' ? 'mypools' : 'unknown');
  
  logBuffer = [];
  stdoutAccumulator = '';
  stderrAccumulator = '';

  const fullArgs = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', path.join(SNAPSHOTS_ROOT, scriptFile),
    ...args
  ];

  broadcast({ type: 'status', status: 'running', taskType: activeTask.type, project: activeTask.project });
  broadcast({ type: 'log', text: `>>> Starting PowerShell task: ${scriptFile} ${args.join(' ')}\n\n`, stream: 'stdout' });

  const child = spawn('powershell.exe', fullArgs, {
    cwd: SNAPSHOTS_ROOT,
    env: { ...process.env, PAGER: 'cat' }
  });

  child.stdout.on('data', (data) => {
    processLogChunk(data.toString('utf8'), 'stdout');
  });

  child.stderr.on('data', (data) => {
    processLogChunk(data.toString('utf8'), 'stderr');
  });

  child.on('close', (code) => {
    // Flush accumulators
    if (stdoutAccumulator) {
      appendAndBroadcastLog(stdoutAccumulator + '\n', 'stdout');
      stdoutAccumulator = '';
    }
    if (stderrAccumulator) {
      appendAndBroadcastLog(stderrAccumulator + '\n', 'stderr');
      stderrAccumulator = '';
    }

    activeTask.status = 'idle';
    activeTask.type = null;
    activeTask.project = null;

    broadcast({ type: 'status', status: 'idle', taskType: null, project: null });
    
    if (code === 0) {
      broadcast({ type: 'log', text: `\n>>> Operation Completed Successfully.\n`, stream: 'stdout' });
      broadcast({ type: 'done', code: 0 });
    } else {
      broadcast({ type: 'log', text: `\n>>> Operation Failed with exit code ${code}.\n`, stream: 'stderr' });
      broadcast({ type: 'done', code });
    }
  });

  child.on('error', (err) => {
    if (stdoutAccumulator) appendAndBroadcastLog(stdoutAccumulator + '\n', 'stdout');
    if (stderrAccumulator) appendAndBroadcastLog(stderrAccumulator + '\n', 'stderr');
    stdoutAccumulator = '';
    stderrAccumulator = '';

    activeTask.status = 'idle';
    activeTask.type = null;
    activeTask.project = null;

    broadcast({ type: 'status', status: 'idle', taskType: null, project: null });
    broadcast({ type: 'log', text: `\n>>> Failed to start process: ${err.message}\n`, stream: 'stderr' });
    broadcast({ type: 'done', code: -1 });
  });
}

// Config Watcher state: map of project -> { fileWatchers, fileHashes }
const projectWatchers = new Map();

function watchConfigChanges(projectPath, projectName) {
  if (!projectPath || !fs.existsSync(projectPath)) return;
  
  // Clean up any existing watchers for this project first
  if (projectWatchers.has(projectName)) {
    const pw = projectWatchers.get(projectName);
    if (pw && pw.watchers) {
      pw.watchers.forEach(w => {
        try { w.close(); } catch(e) {}
      });
    }
    projectWatchers.delete(projectName);
  }
  
  const localDir = path.join(projectPath, '.local');
  if (!fs.existsSync(localDir)) {
    try {
      fs.mkdirSync(localDir, { recursive: true });
    } catch (e) {}
  }
  
  const backupDir = path.join(localDir, 'config-backups');
  if (!fs.existsSync(backupDir)) {
    try {
      fs.mkdirSync(backupDir, { recursive: true });
    } catch (e) {}
  }

  const filesToWatch = [
    '.env',
    '.env.local',
    'compose.yml',
    'compose.edge.yml',
    'nginx/edge/conf.d/mypools-edge.conf',
    'nginx/edge/conf.d/essop-edge.conf',
    'nginx/conf.d/mypools.conf',
    'nginx/conf.d/essop.conf',
    'secrets/wp-config.local.php'
  ];

  const watcherMap = {
    watchers: [],
    hashes: {}
  };

  const getMD5 = (filePath) => {
    try {
      if (!fs.existsSync(filePath)) return null;
      const content = fs.readFileSync(filePath);
      return crypto.createHash('md5').update(content).digest('hex');
    } catch (e) {
      return null;
    }
  };

  const handleFileChange = (relPath) => {
    const fullPath = path.join(projectPath, relPath);
    if (!fs.existsSync(fullPath)) return;

    const hash = getMD5(fullPath);
    if (!hash) return;

    // Check if hash matches previous known hash to avoid duplicate triggers
    if (watcherMap.hashes[relPath] === hash) return;
    watcherMap.hashes[relPath] = hash;

    // Verify if the content is different from the latest backup in backupDir
    const fileId = relPath.replace(/\\/g, '/').replace(/[^a-zA-Z0-9.\-_]/g, '_');
    try {
      const backups = fs.readdirSync(backupDir)
        .filter(f => f.startsWith(fileId + '_') && f.endsWith('.bak'))
        .sort();
      
      if (backups.length > 0) {
        const latestBackup = backups[backups.length - 1];
        const latestBackupPath = path.join(backupDir, latestBackup);
        const latestBackupHash = getMD5(latestBackupPath);
        if (latestBackupHash === hash) {
          return; // Content is identical to the latest backup
        }
      }

      // Write new backup
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupName = `${fileId}_${timestamp}.bak`;
      fs.copyFileSync(fullPath, path.join(backupDir, backupName));
      console.log(`[Watcher] Backed up ${relPath} to ${backupName}`);

      // Keep only last 15 backups
      const allBackups = fs.readdirSync(backupDir)
        .filter(f => f.startsWith(fileId + '_') && f.endsWith('.bak'))
        .sort();
      
      if (allBackups.length > 15) {
        const toDelete = allBackups.slice(0, allBackups.length - 15);
        for (const fileToDelete of toDelete) {
          try {
            fs.unlinkSync(path.join(backupDir, fileToDelete));
          } catch (e) {}
        }
      }
    } catch (err) {
      console.error(`[Watcher] Error backing up ${relPath}:`, err);
    }
  };

  // Setup initial hashes and start watching directories
  const watchedDirs = new Set();
  
  filesToWatch.forEach(relPath => {
    const fullPath = path.join(projectPath, relPath);
    if (fs.existsSync(fullPath)) {
      watcherMap.hashes[relPath] = getMD5(fullPath);
    }
    const dirPath = path.dirname(fullPath);
    if (fs.existsSync(dirPath)) {
      watchedDirs.add(dirPath);
    }
  });

  let debounceTimers = {};
  watchedDirs.forEach(dirPath => {
    try {
      const watcher = fs.watch(dirPath, (eventType, filename) => {
        if (!filename) return;
        
        filesToWatch.forEach(relPath => {
          const expectedBasename = path.basename(relPath);
          if (filename.toLowerCase() === expectedBasename.toLowerCase()) {
            if (debounceTimers[relPath]) clearTimeout(debounceTimers[relPath]);
            debounceTimers[relPath] = setTimeout(() => {
              handleFileChange(relPath);
            }, 300);
          }
        });
      });
      watcherMap.watchers.push(watcher);
    } catch (e) {
      console.error(`[Watcher] Failed to watch directory ${dirPath}:`, e);
    }
  });

  projectWatchers.set(projectName, watcherMap);
  console.log(`[Watcher] Initialized watcher for project "${projectName}" in ${projectPath}`);
}

function getLocalLanIp() {
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          const addr = iface.address;
          if (addr.startsWith('192.168.') || addr.startsWith('10.') || addr.startsWith('172.')) {
            return addr;
          }
        }
      }
    }
  } catch (e) {}
  return '127.0.0.1';
}

// Router and Request Handler
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- API Routes ---

  // 1. SSE Logger Stream
  if (pathname === '/api/logs/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    sseClients.add(res);

    // Stream existing buffer to catch up
    for (const entry of logBuffer) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    // Send current status
    res.write(`data: ${JSON.stringify({ type: 'status', status: activeTask.status, taskType: activeTask.type, project: activeTask.project })}\n\n`);

    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // GET /api/fs/browse
  if (pathname === '/api/fs/browse' && method === 'GET') {
    const psScript = `
      Add-Type -AssemblyName System.Windows.Forms;
      $f = New-Object System.Windows.Forms.FolderBrowserDialog;
      $f.Description = 'Select Project Folder';
      $f.ShowNewFolderButton = $true;
      $result = $f.ShowDialog((New-Object System.Windows.Forms.Form -Property @{TopMost=$true}));
      if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
        Write-Output $f.SelectedPath;
      }
    `;
    exec(`powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${psScript.replace(/\n/g, ' ')}"`, (err, stdout) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to open directory browser: ' + err.message }));
      } else {
        const selectedPath = stdout.trim();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ path: selectedPath || null }));
      }
    });
    return;
  }

  // 2. GET /api/projects
  if (pathname === '/api/projects' && method === 'GET') {
    const projs = loadProjects();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ projects: projs.map(p => p.name), details: projs }));
    return;
  }

  // POST /api/projects/add
  if (pathname === '/api/projects/add' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const targetPath = payload.path ? path.resolve(payload.path.trim()) : '';
        
        if (!targetPath || !fs.existsSync(targetPath)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Folder path does not exist on local filesystem.' }));
          return;
        }

        const stats = fs.statSync(targetPath);
        if (!stats.isDirectory()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Provided path is not a directory.' }));
          return;
        }

        const name = path.basename(targetPath) || 'unknown';
        if (!/^[a-zA-Z0-9_\-]+$/.test(name)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Folder name contains invalid characters. Use alphanumeric, dash, or underscore.' }));
          return;
        }

        const projs = loadProjects();
        if (projs.some(p => p.name.toLowerCase() === name.toLowerCase() || p.path.toLowerCase() === targetPath.toLowerCase())) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Project name or path already registered.' }));
          return;
        }

        projs.push({ name, path: targetPath });
        saveProjects(projs);

        // Make sure the project has a Snapshots folder and a .local folder
        const snapsPath = path.join(targetPath, 'Snapshots');
        if (!fs.existsSync(snapsPath)) {
          fs.mkdirSync(snapsPath, { recursive: true });
        }
        const localPath = path.join(targetPath, '.local');
        if (!fs.existsSync(localPath)) {
          fs.mkdirSync(localPath, { recursive: true });
        }

        // Trigger registry refresh
        exec('powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\snapshots\\Refresh-Registry.ps1', () => {
          try {
            watchConfigChanges(targetPath, name);
          } catch (e) {}
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, projects: projs.map(p => p.name), details: projs }));
        });
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Malformed JSON payload: ' + e.message }));
      }
    });
    return;
  }

  // DELETE /api/projects
  if (pathname === '/api/projects' && method === 'DELETE') {
    const project = parsedUrl.query.project;
    if (!project) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing project parameter' }));
      return;
    }

    const projs = loadProjects();
    const index = projs.findIndex(p => p.name.toLowerCase() === project.toLowerCase());
    if (index === -1) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Project not found' }));
      return;
    }

    projs.splice(index, 1);
    saveProjects(projs);

    // Clean up watcher
    if (projectWatchers.has(project)) {
      const pw = projectWatchers.get(project);
      if (pw && pw.watchers) {
        pw.watchers.forEach(w => {
          try { w.close(); } catch (e) {}
        });
      }
      projectWatchers.delete(project);
    }

    // Trigger registry refresh
    exec('powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\snapshots\\Refresh-Registry.ps1', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, projects: projs.map(p => p.name), details: projs }));
    });
    return;
  }

  // 3. GET /api/snapshots
  if (pathname === '/api/snapshots' && method === 'GET') {
    const project = parsedUrl.query.project;
    if (!project || !/^[a-zA-Z0-9_\-]+$/.test(project)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or missing project name' }));
      return;
    }

    // First trigger Refresh-Registry.ps1 to make sure json is completely updated
    exec('powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\snapshots\\Refresh-Registry.ps1', (err) => {
      if (err) {
        console.error('Refresh-Registry.ps1 failed', err);
      }

      const registryPath = path.join(SNAPSHOTS_ROOT, 'registry.json');
      fs.readFile(registryPath, 'utf8', (readErr, data) => {
        if (readErr) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ name: project, source_path: '', snapshots: [] }));
          return;
        }

        try {
          const cleanData = data.replace(/^\uFEFF/, '');
          const registry = JSON.parse(cleanData);
          const projectData = registry[project] || { name: project, source_path: '', snapshots: [] };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(projectData));
        } catch (parseErr) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to parse snapshot registry' }));
        }
      });
    });
    return;
  }

  // 3b. GET /api/project/files
  if (pathname === '/api/project/files' && method === 'GET') {
    const project = parsedUrl.query.project;
    if (!project || !/^[a-zA-Z0-9_\-]+$/.test(project)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or missing project name' }));
      return;
    }

    const registryPath = path.join(SNAPSHOTS_ROOT, 'registry.json');
    fs.readFile(registryPath, 'utf8', (readErr, data) => {
      let sourcePath = '';
      if (!readErr) {
        try {
          const registry = JSON.parse(data.replace(/^\uFEFF/, ''));
          sourcePath = registry[project]?.source_path || '';
        } catch (e) {}
      }

      if (!sourcePath) {
        sourcePath = getProjectPath(project) || '';
      }

      if (!sourcePath || !fs.existsSync(sourcePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Project source directory not found' }));
        return;
      }

      fs.readdir(sourcePath, { withFileTypes: true }, (dirErr, files) => {
        if (dirErr) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to read project files' }));
          return;
        }

        const items = files
          .filter(dirent => !/^(node_modules|\.git)$/i.test(dirent.name))
          .map(dirent => ({
            name: dirent.name,
            isDirectory: dirent.isDirectory()
          }));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sourcePath, items }));
      });
    });
    return;
  }

  // 3c. GET /api/git/status
  if (pathname === '/api/git/status' && method === 'GET') {
    const project = parsedUrl.query.project || 'mypools';
    const gitRepoPath = getProjectPath(project);
    if (!gitRepoPath || !fs.existsSync(gitRepoPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Git repository directory not found' }));
      return;
    }

    exec('git -C ' + gitRepoPath + ' branch --show-current', (branchErr, branchStdout) => {
      const branchName = (branchStdout || 'main').trim();

      exec('git -C ' + gitRepoPath + ' status --porcelain', (statusErr, statusStdout) => {
        if (statusErr) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to run git status: ' + statusErr.message }));
          return;
        }

        const lines = (statusStdout || '').trim().split('\n').filter(Boolean);
        const files = lines.map(line => {
          const status = line.substring(0, 2).trim();
          const filePath = line.substring(3).trim();
          return { status, filePath };
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          branch: branchName,
          files: files,
          modifiedCount: files.filter(f => f.status === 'M' || f.status === 'MM').length,
          untrackedCount: files.filter(f => f.status === '??').length
        }));
      });
    });
    return;
  }

  // 4. POST /api/snapshots/create
  if (pathname === '/api/snapshots/create' && method === 'POST') {
    if (activeTask.status === 'running') {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Another task is currently running' }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { project, description, live, noDb, excludePaths, backupLevel } = payload;

        if (!project || !/^[a-zA-Z0-9_\-]+$/.test(project)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid or missing project name' }));
          return;
        }

        let retentionCount = 5;
        const projectPath = getProjectPath(project);
        if (projectPath) {
          const settingsPath = path.join(projectPath, '.local', 'settings.json');
          if (fs.existsSync(settingsPath)) {
            try {
              const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, ''));
              retentionCount = parseInt(settings.retentionCount, 10) || 5;
            } catch (e) {}
          }
        }
        if (retentionCount <= 0 || retentionCount > 5) {
          retentionCount = 5;
        }

        const args = ['-Project', project, '-Description', description || 'Manual snapshot'];
        if (live) args.push('-Live');
        if (noDb) args.push('-NoDatabase');
        args.push('-RetentionCount', retentionCount.toString());
        if (backupLevel) {
          args.push('-BackupLevel', backupLevel);
        }
        if (excludePaths) {
          const excludesStr = Array.isArray(excludePaths) ? excludePaths.join(',') : excludePaths;
          if (excludesStr) {
            args.push('-ExcludePaths', excludesStr);
          }
        }
        if (projectPath) {
          args.push('-SourcePath', projectPath);
        }

        runPowerShellScript('Create-Snapshot.ps1', args);

        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'running', message: 'Snapshot creation started' }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Malformed JSON payload' }));
      }
    });
    return;
  }

  // 5. POST /api/snapshots/restore
  if (pathname === '/api/snapshots/restore' && method === 'POST') {
    if (activeTask.status === 'running') {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Another task is currently running' }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { project, snapshotName, skipPreBackup } = payload;

        if (!project || !/^[a-zA-Z0-9_\-]+$/.test(project)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid or missing project name' }));
          return;
        }
        if (!snapshotName || !/^[a-zA-Z0-9_\-]+$/.test(snapshotName)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid or missing snapshot name' }));
          return;
        }

        const args = ['-Project', project, '-SnapshotName', snapshotName, '-ConfirmRestore'];
        if (skipPreBackup) args.push('-SkipPreBackup');
        const projectPath = getProjectPath(project);
        if (projectPath) {
          args.push('-SourcePath', projectPath);
        }

        runPowerShellScript('Restore-Snapshot.ps1', args);

        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'running', message: 'Snapshot restoration started' }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Malformed JSON payload' }));
      }
    });
    return;
  }

  // 5b. POST /api/git/deploy
  if (pathname === '/api/git/deploy' && method === 'POST') {
    if (activeTask.status === 'running') {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Another task is currently running' }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { commitMessage, overwriteDb, snapshotName, project } = payload;

        // Enforce snapshot name validation
        if (!snapshotName || snapshotName === 'current-local') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'A valid recovery snapshot must be selected to initiate deployment.' }));
          return;
        }

        const activeProject = project || 'mypools';
        const projectPath = getProjectPath(activeProject);
        if (!projectPath) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Project path not found' }));
          return;
        }

        const args = [];
        if (commitMessage) {
          args.push('-CommitMessage', commitMessage);
        }
        if (overwriteDb) {
          args.push('-OverwriteDatabase');
        }
        args.push('-SnapshotName', snapshotName);
        args.push('-SourcePath', projectPath);

        runPowerShellScript('Deploy-Git.ps1', args);

        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'running', message: 'Git deployment started' }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Malformed JSON payload' }));
      }
    });
    return;
  }

  // 5bb. GET /api/parity/check
  if (pathname === '/api/parity/check' && method === 'GET') {
    const project = parsedUrl.query.project || 'mypools';
    const localRepo = getProjectPath(project);
    if (!localRepo || !fs.existsSync(localRepo)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Project local repository not found' }));
      return;
    }
    const settingsPath = path.join(localRepo, '.local', 'settings.json');
    const secretPath = path.join(localRepo, '.local', 'ssh.secret.txt');

    let settings = {
      sshHost: '152.42.220.5',
      sshUser: 'root',
      sshPassword: '',
      sshHostKey: 'SHA256:ZJmY20MEfjIPQ9I3uWA4Thql8y70nQxjY6za9LMiDBg',
      gitRepo: localRepo,
      gitBranch: 'main',
      siteUrl: 'https://mypools.co.za'
    };

    if (fs.existsSync(secretPath)) {
      try {
        settings.sshPassword = fs.readFileSync(secretPath, 'utf8').trim();
      } catch (e) {}
    }

    if (fs.existsSync(settingsPath)) {
      try {
        const fileData = fs.readFileSync(settingsPath, 'utf8');
        const parsed = JSON.parse(fileData);
        settings = { ...settings, ...parsed };
      } catch (e) {}
    }

    const localComposeProject = getComposeProjectName(localRepo, `${project}-local`);
    const remoteComposeProject = getComposeProjectName(localRepo, `${project}-pod`);
    const siteUrl = settings.siteUrl || 'https://mypools.co.za';
    const siteDomain = url.parse(siteUrl).hostname || 'mypools.co.za';
    const vpsInstallRoot = settings.vpsInstallRoot || `/opt/${project.toLowerCase()}`;

    // Function to run SSH command via plink
    const runSsh = (cmd) => {
      return new Promise((resolve) => {
        const plinkTool = fs.existsSync(path.join(localRepo, 'tools', 'plink.exe')) 
          ? path.join(localRepo, 'tools', 'plink.exe') 
          : (fs.existsSync('C:\\snapshots\\tools\\plink.exe') ? 'C:\\snapshots\\tools\\plink.exe' : 'plink.exe');
        const escapedCmd = cmd.replace(/"/g, '\\"');
        const plinkCmd = `"${plinkTool}" -ssh ${settings.sshUser}@${settings.sshHost} -batch -hostkey "${settings.sshHostKey}" -pw "${settings.sshPassword}" "${escapedCmd}"`;
        
        exec(plinkCmd, { timeout: 12000 }, (error, stdout, stderr) => {
          if (error) {
            resolve('');
          } else {
            resolve(stdout.trim());
          }
        });
      });
    };


    // Helper to check SSL cert
    const checkSsl = (domain) => {
      return new Promise((resolve) => {
        const tls = require('tls');
        const socket = tls.connect(443, domain, { servername: domain, timeout: 5000 }, () => {
          const cert = socket.getPeerCertificate();
          socket.end();
          if (cert && cert.valid_to) {
            const expiry = new Date(cert.valid_to);
            const daysRemaining = Math.max(0, Math.round((expiry - new Date()) / (1000 * 60 * 60 * 24)));
            resolve({
              valid: true,
              subject: cert.subject.CN,
              issuer: cert.issuer.O,
              expiry: cert.valid_to,
              daysRemaining
            });
          } else {
            resolve({ valid: false, error: 'No certificate retrieved' });
          }
        });
        socket.on('error', (err) => {
          resolve({ valid: false, error: err.message });
        });
      });
    };

    // Parse local HTTP port from .env or .env.local
    let localPort = '9080';
    try {
      const envPath = fs.existsSync(path.join(localRepo, '.env.local')) 
        ? path.join(localRepo, '.env.local') 
        : path.join(localRepo, '.env');
      if (fs.existsSync(envPath)) {
        const lines = fs.readFileSync(envPath, 'utf8').split('\n');
        for (const line of lines) {
          if (line.trim().startsWith('APP_HTTP_PORT=')) {
            localPort = line.split('=')[1].trim().replace(/['"]/g, '');
            break;
          }
        }
      }
    } catch (e) {}

    // Run auditing steps concurrently
    Promise.all([
      // 1. Local Git Commit
      new Promise((resolve) => {
        exec(`git -C "${localRepo}" rev-parse HEAD`, (err, stdout) => {
          resolve(err ? 'unknown' : stdout.trim());
        });
      }),
      // 2. VPS Git Commit
      runSsh(`cat ${vpsInstallRoot}/deploy-status.json 2>/dev/null || git -C ${vpsInstallRoot} log -1 --format=%H`),
      // 3. Local Containers Status
      new Promise((resolve) => {
        exec(`podman ps --filter label=io.podman.compose.project=${localComposeProject} --format "{{.Names}} ({{.Status}})"`, (err, stdout) => {
          resolve(err ? '' : stdout.trim());
        });
      }),
      // 4. VPS Containers Status
      runSsh(`podman ps --filter label=io.podman.compose.project=${remoteComposeProject} --format "{{.Names}} ({{.Status}})"`),
      // 5. SSL check
      checkSsl(siteDomain),
      // 6. VPS system metrics
      runSsh('df -h / | tail -n 1 && echo "---" && free -m | grep Mem && echo "---" && uptime'),
      // 7. Endpoints checks
      Promise.all([
        // Homepage
        fetchUrl(`http://127.0.0.1:${localPort}/`).then(loc => 
          fetchUrl(`${siteUrl}/`).then(prd => ({ path: '/', name: 'Homepage', local: loc, prod: prd }))
        ),
        // Contractors page
        fetchUrl(`http://127.0.0.1:${localPort}/contractors`).then(loc => 
          fetchUrl(`${siteUrl}/contractors`).then(prd => ({ path: '/contractors', name: 'Contractors Directory', local: loc, prod: prd }))
        ),
        // Admin login page
        fetchUrl(`http://127.0.0.1:${localPort}/wp-login.php`).then(loc => 
          fetchUrl(`${siteUrl}/wp-login.php`).then(prd => ({ path: '/wp-login.php', name: 'Admin Login', local: loc, prod: prd }))
        )
      ])
    ]).then(([localCommit, vpsCommitRaw, localContainers, vpsContainers, ssl, vpsMetrics, endpoints]) => {
      // Parse vpsCommit
      let vpsCommit = vpsCommitRaw.trim();
      if (vpsCommit.startsWith('{')) {
        try {
          const parsed = JSON.parse(vpsCommit);
          vpsCommit = parsed.commit || vpsCommit;
        } catch (e) {}
      }

      // Parse container lists
      const parseContainers = (str) => {
        const services = ['mysql', 'redis', 'php', 'nginx'];
        const result = {};
        services.forEach(svc => {
          const match = str.split('\n').find(line => line.toLowerCase().includes(svc));
          if (match) {
            result[svc] = match.includes('Up') || match.includes('running') || match.includes('healthy') ? 'running' : 'stopped';
          } else {
            result[svc] = 'missing';
          }
        });
        return result;
      };

      const localSvc = parseContainers(localContainers);
      const vpsSvc = parseContainers(vpsContainers);

      // Analyze page contents for port leaks & database connection errors
      let portLeakDetected = false;
      let dbErrorDetected = false;
      const endpointResults = endpoints.map(ep => {
        const localTitleMatch = ep.local.body.match(/<title>(.*?)<\/title>/i);
        const prodTitleMatch = ep.prod.body.match(/<title>(.*?)<\/title>/i);
        const localTitle = localTitleMatch ? localTitleMatch[1] : '';
        const prodTitle = prodTitleMatch ? prodTitleMatch[1] : '';

        // Check for leaks
        const epPortLeak = ep.prod.body.includes(':9080') || ep.prod.body.includes(':9082');
        if (epPortLeak) portLeakDetected = true;

        const epDbError = ep.prod.body.includes('Error establishing a database connection') || 
                          ep.prod.body.includes('WordPress database error') ||
                          ep.local.body.includes('Error establishing a database connection') ||
                          ep.local.body.includes('WordPress database error');
        if (epDbError) dbErrorDetected = true;

        return {
          path: ep.path,
          name: ep.name,
          localStatus: ep.local.status,
          localTime: ep.local.responseTime,
          localTitle,
          prodStatus: ep.prod.status,
          prodTime: ep.prod.responseTime,
          prodTitle,
          portLeak: epPortLeak,
          dbError: epDbError,
          titleParity: localTitle === prodTitle && localTitle !== ''
        };
      });

      // Parse VPS metrics
      let diskUsage = 'unknown';
      let memoryUsage = 'unknown';
      let cpuLoad = 'unknown';

      if (vpsMetrics) {
        const parts = vpsMetrics.split('---');
        if (parts[0]) {
          // Parse disk
          const diskFields = parts[0].trim().split(/\s+/);
          if (diskFields.length >= 5) {
            diskUsage = diskFields[4]; // e.g. 45%
          }
        }
        if (parts[1]) {
          // Parse memory: Mem: total used free shared buff/cache available
          const memFields = parts[1].trim().split(/\s+/);
          if (memFields.length >= 3) {
            memoryUsage = `${memFields[2]} MB / ${memFields[1]} MB`;
          }
        }
        if (parts[2]) {
          // Parse load average
          const loadMatch = parts[2].match(/load average:\s*([0-9.,\s]+)/i);
          if (loadMatch) {
            cpuLoad = loadMatch[1].trim();
          }
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        git: {
          localCommit,
          vpsCommit,
          parity: localCommit === vpsCommit && localCommit !== 'unknown'
        },
        containers: {
          local: localSvc,
          vps: vpsSvc
        },
        endpoints: endpointResults,
        security: {
          portLeakDetected,
          dbErrorDetected,
          ssl
        },
        system: {
          diskUsage,
          memoryUsage,
          cpuLoad
        }
      }));
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Audit failed: ' + err.message }));
    });
    return;
  }

  // 5c. GET /api/settings
  if (pathname === '/api/settings' && method === 'GET') {
    const project = parsedUrl.query.project || 'mypools';
    const localRepo = getProjectPath(project);
    if (!localRepo || !fs.existsSync(localRepo)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Project directory not found' }));
      return;
    }
    const settingsPath = path.join(localRepo, '.local', 'settings.json');
    const secretPath = path.join(localRepo, '.local', 'ssh.secret.txt');

    let settings = {
      sshHost: '152.42.220.5',
      sshUser: 'root',
      sshPassword: '',
      sshHostKey: 'SHA256:ZJmY20MEfjIPQ9I3uWA4Thql8y70nQxjY6za9LMiDBg',
      gitRepo: localRepo,
      gitBranch: 'main',
      siteUrl: 'https://mypools.co.za',
      vpsInstallRoot: `/opt/${project.toLowerCase()}`,
      retentionCount: 0
    };

    // Fallback password from ssh.secret.txt
    if (fs.existsSync(secretPath)) {
      try {
        settings.sshPassword = fs.readFileSync(secretPath, 'utf8').trim();
      } catch (e) {
        console.error('Failed to read ssh.secret.txt', e);
      }
    }

    if (fs.existsSync(settingsPath)) {
      try {
        const fileData = fs.readFileSync(settingsPath, 'utf8');
        const parsed = JSON.parse(fileData);
        settings = { ...settings, ...parsed };
      } catch (e) {
        console.error('Failed to read settings.json', e);
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(settings));
    return;
  }

  // 5d. POST /api/settings
  if (pathname === '/api/settings' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { project, sshHost, sshUser, sshPassword, sshHostKey, gitBranch, siteUrl, vpsInstallRoot, retentionCount } = payload;

        const activeProject = project || 'mypools';
        const localRepo = getProjectPath(activeProject);
        if (!localRepo || !fs.existsSync(localRepo)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Project directory not found' }));
          return;
        }
        const localDir = path.join(localRepo, '.local');
        
        // Ensure directory exists
        if (!fs.existsSync(localDir)) {
          fs.mkdirSync(localDir, { recursive: true });
        }

        const settingsPath = path.join(localDir, 'settings.json');
        const secretPath = path.join(localDir, 'ssh.secret.txt');

        const settings = {
          sshHost: sshHost || '152.42.220.5',
          sshUser: sshUser || 'root',
          sshPassword: sshPassword || '',
          sshHostKey: sshHostKey || 'SHA256:ZJmY20MEfjIPQ9I3uWA4Thql8y70nQxjY6za9LMiDBg',
          gitRepo: localRepo,
          gitBranch: gitBranch || 'main',
          siteUrl: siteUrl || 'https://mypools.co.za',
          vpsInstallRoot: vpsInstallRoot || `/opt/${activeProject.toLowerCase()}`,
          retentionCount: parseInt(retentionCount, 10) || 0
        };

        // Write settings.json
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');

        // Write ssh.secret.txt
        if (sshPassword) {
          fs.writeFileSync(secretPath, sshPassword.trim(), 'utf8');
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Settings saved successfully' }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to save settings: ' + e.message }));
      }
    });
    return;
  }

  // 6. DELETE /api/snapshots
  if (pathname === '/api/snapshots' && method === 'DELETE') {
    if (activeTask.status === 'running') {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Cannot delete snapshots while a task is running' }));
      return;
    }

    const project = parsedUrl.query.project;
    const name = parsedUrl.query.name;

    if (!project || !/^[a-zA-Z0-9_\-]+$/.test(project)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or missing project name' }));
      return;
    }
    if (!name || !/^[a-zA-Z0-9_\-]+$/.test(name)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or missing snapshot name' }));
      return;
    }

    const projectPath = getProjectPath(project);
    if (!projectPath) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Project path not found' }));
      return;
    }
    let targetDir = path.join(projectPath, 'Snapshots', name);
    if (!fs.existsSync(targetDir)) {
      targetDir = path.join(projectPath, '.snapshots', name);
    }

    // Safety check: ensure targetDir is within projectPath\Snapshots or projectPath\.snapshots
    const resolvedPath = path.resolve(targetDir);
    const expectedPrefix1 = path.resolve(path.join(projectPath, 'Snapshots'));
    const expectedPrefix2 = path.resolve(path.join(projectPath, '.snapshots'));
    if (!resolvedPath.startsWith(expectedPrefix1) && !resolvedPath.startsWith(expectedPrefix2)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Access denied: unsafe path' }));
      return;
    }

    fs.rm(targetDir, { recursive: true, force: true }, (err) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Failed to delete snapshot directory: ${err.message}` }));
        return;
      }

      // Re-run registry refresh
      exec('powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\snapshots\\Refresh-Registry.ps1', (refreshErr) => {
        if (refreshErr) {
          console.error('Refresh-Registry.ps1 failed after delete', refreshErr);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: `Snapshot ${name} deleted successfully` }));
      });
    });
    return;
  }

  // GET /api/project/check-ports
  if (pathname === '/api/project/check-ports' && method === 'GET') {
    const project = parsedUrl.query.project || 'mypools';
    const projectPath = getProjectPath(project);
    if (!projectPath || !fs.existsSync(projectPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Project directory not found' }));
      return;
    }

    // Helper functions
    const readEnvFiles = (projPath) => {
      const envs = {};
      const files = ['.env', '.env.local'];
      for (const f of files) {
        const fp = path.join(projPath, f);
        if (fs.existsSync(fp)) {
          try {
            const content = fs.readFileSync(fp, 'utf8');
            content.split('\n').forEach(line => {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith('#')) return;
              const eqIdx = trimmed.indexOf('=');
              if (eqIdx !== -1) {
                const key = trimmed.substring(0, eqIdx).trim();
                const val = trimmed.substring(eqIdx + 1).trim().replace(/['"]/g, '');
                envs[key] = val;
              }
            });
          } catch (e) {}
        }
      }
      return envs;
    };

    const resolveEnvValue = (expr, envs) => {
      const match = expr.match(/\${([A-Za-z0-9_]+)(?::-([^}]+))?}/);
      if (match) {
        const varName = match[1];
        const defaultValue = match[2] || '';
        if (envs[varName] !== undefined) {
          return envs[varName];
        }
        return defaultValue;
      }
      return expr;
    };

    // 1. Load envs
    const envs = readEnvFiles(projectPath);

    // 2. Find and parse compose file ports
    const composeFiles = ['compose.yml', 'docker-compose.yml', 'compose.edge.yml', 'podman-compose.yml'];
    const foundPorts = new Set();
    const portMappings = [];

    for (const file of composeFiles) {
      const filePath = path.join(projectPath, file);
      if (fs.existsSync(filePath)) {
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const lines = content.split('\n');
          let inPorts = false;
          let indent = 0;
          let currentService = 'unknown';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;

            const leadingSpaces = line.length - line.trimStart().length;

            if (leadingSpaces === 2 && trimmed.endsWith(':') && !trimmed.startsWith('-')) {
              currentService = trimmed.substring(0, trimmed.length - 1).trim();
            }

            if (inPorts) {
              if (leadingSpaces > indent && trimmed.startsWith('-')) {
                const portSpec = trimmed.substring(1).trim().replace(/['"]/g, '');
                const parts = portSpec.split(':');
                let hostPortExpr = '';
                let containerPort = '';
                if (parts.length === 3) {
                  hostPortExpr = parts[1];
                  containerPort = parts[2];
                } else if (parts.length === 2) {
                  hostPortExpr = parts[0];
                  containerPort = parts[1];
                } else if (parts.length === 1) {
                  hostPortExpr = parts[0];
                  containerPort = parts[0];
                }

                const resolvedHostPort = resolveEnvValue(hostPortExpr.trim(), envs);
                const portNum = parseInt(resolvedHostPort, 10);
                if (!isNaN(portNum)) {
                  foundPorts.add(portNum);
                  portMappings.push({
                    port: portNum,
                    raw: portSpec,
                    service: currentService,
                    containerPort: containerPort,
                    file: file
                  });
                }
              } else if (leadingSpaces <= indent) {
                inPorts = false;
              }
            }

            if (trimmed.startsWith('ports:')) {
              inPorts = true;
              indent = leadingSpaces;
            }
          }
        } catch (e) {
          console.error(`Failed to parse compose file ${file}`, e);
        }
      }
    }

    const portsToCheck = Array.from(foundPorts);
    if (portsToCheck.length === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ports: [] }));
      return;
    }

    // 3. Check port availability using net sockets
    const net = require('net');
    const checkPromises = portsToCheck.map(port => {
      return new Promise((resolve) => {
        const testServer = net.createServer();
        testServer.once('error', (err) => {
          if (err.code === 'EADDRINUSE') {
            resolve({ port, free: false });
          } else {
            resolve({ port, free: true });
          }
        });
        testServer.once('listening', () => {
          testServer.close(() => {
            resolve({ port, free: true });
          });
        });
        testServer.listen(port, '127.0.0.1');
      });
    });

    Promise.all(checkPromises).then(results => {
      const mappedResults = portMappings.map(mapping => {
        const check = results.find(r => r.port === mapping.port);
        return {
          ...mapping,
          free: check ? check.free : true
        };
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ports: mappedResults }));
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Port checking failed: ' + err.message }));
    });
    return;
  }

  // GET /api/containers/stats
  if (pathname === '/api/containers/stats' && method === 'GET') {
    const project = parsedUrl.query.project || 'mypools';
    const projectPath = getProjectPath(project);
    if (!projectPath || !fs.existsSync(projectPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Project directory not found' }));
      return;
    }

    const composeProjectName = getComposeProjectName(projectPath, `${project}-local`);

    exec('podman stats --no-stream --format "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}"', (err, stdout, stderr) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to run podman stats: ' + err.message }));
        return;
      }

      const lines = (stdout || '').trim().split('\n').filter(Boolean);
      const stats = [];
      for (const line of lines) {
        const parts = line.split('|');
        if (parts.length === 5) {
          const name = parts[0].trim();
          const isProjectContainer = name.toLowerCase().startsWith(composeProjectName.toLowerCase()) || 
                                     name.toLowerCase().includes(project.toLowerCase());
          if (isProjectContainer) {
            stats.push({
              name,
              cpu: parts[1].trim(),
              memUsage: parts[2].trim(),
              memPerc: parts[3].trim(),
              netIo: parts[4].trim()
            });
          }
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stats }));
    });
    return;
  }

  // GET /api/git/diff-preview
  if (pathname === '/api/git/diff-preview' && method === 'GET') {
    const project = parsedUrl.query.project || 'mypools';
    const snapshotName = parsedUrl.query.snapshotName;
    if (!snapshotName) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing snapshotName parameter' }));
      return;
    }

    const localRepo = getProjectPath(project);
    if (!localRepo || !fs.existsSync(localRepo)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Project local repository not found' }));
      return;
    }

    // 1. Read metadata of snapshot
    let snapshotDir = path.join(localRepo, 'Snapshots', snapshotName);
    if (!fs.existsSync(snapshotDir)) {
      snapshotDir = path.join(localRepo, '.snapshots', snapshotName);
    }
    const snapMetadataPath = path.join(snapshotDir, 'snapshot.json');
    if (!fs.existsSync(snapMetadataPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Snapshot metadata not found for ${snapshotName}` }));
      return;
    }

    let snapshotCommit = '';
    try {
      const snapMetadata = JSON.parse(fs.readFileSync(snapMetadataPath, 'utf8').replace(/^\uFEFF/, ''));
      snapshotCommit = snapMetadata.git_commit || '';
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read snapshot metadata: ' + e.message }));
      return;
    }

    if (!snapshotCommit) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No Git commit hash recorded in this snapshot' }));
      return;
    }

    // 2. Fetch vpsCommit by reading settings and running plink SSH query
    const settingsPath = path.join(localRepo, '.local', 'settings.json');
    const secretPath = path.join(localRepo, '.local', 'ssh.secret.txt');

    let settings = {
      sshHost: '152.42.220.5',
      sshUser: 'root',
      sshPassword: '',
      sshHostKey: 'SHA256:ZJmY20MEfjIPQ9I3uWA4Thql8y70nQxjY6za9LMiDBg',
      vpsInstallRoot: `/opt/${project.toLowerCase()}`
    };

    if (fs.existsSync(secretPath)) {
      try { settings.sshPassword = fs.readFileSync(secretPath, 'utf8').trim(); } catch (e) {}
    }
    if (fs.existsSync(settingsPath)) {
      try {
        const fileData = fs.readFileSync(settingsPath, 'utf8');
        settings = { ...settings, ...JSON.parse(fileData) };
      } catch (e) {}
    }

    const runSsh = (cmd) => {
      return new Promise((resolve) => {
        const plinkTool = fs.existsSync(path.join(localRepo, 'tools', 'plink.exe')) 
          ? path.join(localRepo, 'tools', 'plink.exe') 
          : (fs.existsSync('C:\\snapshots\\tools\\plink.exe') ? 'C:\\snapshots\\tools\\plink.exe' : 'plink.exe');
        const escapedCmd = cmd.replace(/"/g, '\\"');
        const plinkCmd = `"${plinkTool}" -ssh ${settings.sshUser}@${settings.sshHost} -batch -hostkey "${settings.sshHostKey}" -pw "${settings.sshPassword}" "${escapedCmd}"`;
        
        exec(plinkCmd, { timeout: 10000 }, (error, stdout) => {
          if (error) {
            resolve('');
          } else {
            resolve(stdout.trim());
          }
        });
      });
    };

    const vpsInstallRoot = settings.vpsInstallRoot || `/opt/${project.toLowerCase()}`;

    runSsh(`cat ${vpsInstallRoot}/deploy-status.json 2>/dev/null || git -C ${vpsInstallRoot} log -1 --format=%H`).then(vpsCommitRaw => {
      let vpsCommit = vpsCommitRaw.trim();
      if (vpsCommit.startsWith('{')) {
        try {
          const parsed = JSON.parse(vpsCommit);
          vpsCommit = parsed.commit || vpsCommit;
        } catch (e) {}
      }

      if (!vpsCommit || !/^[a-f0-9]+$/i.test(vpsCommit)) {
        // VPS commit not reachable/unknown, fallback to diffing against HEAD
        exec(`git -C "${localRepo}" diff --stat HEAD ${snapshotCommit}`, (err, stdout, stderr) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            vpsCommit: 'unknown',
            snapshotCommit,
            diff: stdout ? stdout.trim() : (err ? `Git error: ${stderr || err.message}` : 'No changes'),
            isFallback: true
          }));
        });
        return;
      }

      // VPS commit successfully retrieved, run diff
      exec(`git -C "${localRepo}" diff --stat ${vpsCommit} ${snapshotCommit}`, (diffErr, diffStdout, diffStderr) => {
        if (diffErr) {
          // Fallback to diffing against HEAD
          exec(`git -C "${localRepo}" diff --stat HEAD ${snapshotCommit}`, (fallbackErr, fallbackStdout, fallbackStderr) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              vpsCommit,
              snapshotCommit,
              diff: fallbackStdout ? fallbackStdout.trim() : (fallbackErr ? `Git error: ${fallbackStderr || fallbackErr.message}` : 'No changes'),
              isFallback: true,
              warning: `VPS commit ${vpsCommit} is missing from local history; showing diff against local HEAD instead.`
            }));
          });
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            vpsCommit,
            snapshotCommit,
            diff: diffStdout ? diffStdout.trim() : 'No changes',
            isFallback: false
          }));
        }
      });
    });
    return;
  }

  // GET /api/local-health
  if (pathname === '/api/local-health' && method === 'GET') {
    const projectName = parsedUrl.query.project || 'mypools';
    const projectPath = getProjectPath(projectName);
    if (!projectPath || !fs.existsSync(projectPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Project directory not found' }));
      return;
    }

    const localComposeProject = getComposeProjectName(projectPath, `${projectName}-local`);

    // Check containers status
    const checkContainers = () => {
      return new Promise((resolve) => {
        exec(`podman ps -a --filter label=io.podman.compose.project=${localComposeProject} --format "{{.Names}} ({{.Status}})"`, (err, stdout) => {
          if (err) {
            resolve({ raw: '', parsed: {} });
            return;
          }
          const raw = stdout.trim();
          const services = ['mysql', 'redis', 'php', 'nginx', 'edge'];
          const parsed = {};
          services.forEach(svc => {
            const match = raw.split('\n').find(line => line.toLowerCase().includes(`_${svc}_`) || line.toLowerCase().endsWith(`_${svc}`));
            if (match) {
              const isUp = match.includes('Up') || match.includes('running') || match.includes('healthy');
              parsed[svc] = {
                status: isUp ? 'running' : 'stopped',
                name: match.split(' ')[0],
                rawStatus: match.substring(match.indexOf(' ') + 1)
              };
            } else {
              parsed[svc] = { status: 'missing', name: '', rawStatus: '' };
            }
          });
          resolve({ raw, parsed });
        });
      });
    };

    // Parse WP credentials and config
    const parseWpConfig = () => {
      const secretsDir = path.join(projectPath, 'secrets');
      const wpConfigPath = fs.existsSync(path.join(secretsDir, 'wp-config.local.php'))
        ? path.join(secretsDir, 'wp-config.local.php')
        : path.join(projectPath, 'wp-config.local.php');

      const diagnostics = {
        wpConfigExists: false,
        dbHost: 'missing',
        dbHostVal: '',
        wpUrls: 'missing',
        wpUrlsVal: '',
        dbUser: '',
        dbPassword: '',
        dbName: ''
      };

      if (fs.existsSync(wpConfigPath)) {
        diagnostics.wpConfigExists = true;
        try {
          const content = fs.readFileSync(wpConfigPath, 'utf8');
          
          const dbHostMatch = content.match(/define\(\s*['"]DB_HOST['"]\s*,\s*['"]([^'"]+)['"]\s*\)/);
          if (dbHostMatch) {
            diagnostics.dbHostVal = dbHostMatch[1];
            diagnostics.dbHost = (dbHostMatch[1] === 'mysql') ? 'ok' : 'error';
          }

          const dbUserMatch = content.match(/define\(\s*['"]DB_USER['"]\s*,\s*['"]([^'"]+)['"]\s*\)/);
          if (dbUserMatch) diagnostics.dbUser = dbUserMatch[1];

          const dbPasswordMatch = content.match(/define\(\s*['"]DB_PASSWORD['"]\s*,\s*['"]([^'"]+)['"]\s*\)/);
          if (dbPasswordMatch) diagnostics.dbPassword = dbPasswordMatch[1];

          const dbNameMatch = content.match(/define\(\s*['"]DB_NAME['"]\s*,\s*['"]([^'"]+)['"]\s*\)/);
          if (dbNameMatch) diagnostics.dbName = dbNameMatch[1];

          const dynamicUrlCheck = content.includes("$_SERVER['HTTP_HOST']");
          if (content.includes('WP_HOME')) {
            diagnostics.wpUrls = dynamicUrlCheck ? 'ok' : 'warning';
            const homeMatch = content.match(/define\(\s*['"]WP_HOME['"]\s*,\s*([^)]+)\)/);
            if (homeMatch) diagnostics.wpUrlsVal = homeMatch[1].trim();
          }
        } catch (e) {}
      }

      return { path: wpConfigPath, data: diagnostics };
    };

    // Parse Nginx configs
    const parseNginxConfig = () => {
      const edgeConfDir = path.join(projectPath, 'nginx', 'edge', 'conf.d');
      const diagnostics = {
        nginxConfigExists: false,
        path: '',
        nginxUpstream: 'missing',
        nginxUpstreamVal: '',
        nginxHostHeader: 'missing'
      };

      if (fs.existsSync(edgeConfDir)) {
        try {
          const files = fs.readdirSync(edgeConfDir).filter(f => f.endsWith('.conf'));
          if (files.length > 0) {
            const confFile = path.join(edgeConfDir, files[0]);
            diagnostics.nginxConfigExists = true;
            diagnostics.path = confFile;
            const content = fs.readFileSync(confFile, 'utf8');

            const passMatch = content.match(/proxy_pass\s+([^;]+);/);
            if (passMatch) {
              const upstream = passMatch[1].trim();
              diagnostics.nginxUpstreamVal = upstream;
              diagnostics.nginxUpstream = (upstream.includes('php:80') || upstream === 'http://php') ? 'ok' : 'error';
            }

            const hostHeaderMatch = content.includes('proxy_set_header Host $http_host;');
            diagnostics.nginxHostHeader = hostHeaderMatch ? 'ok' : 'error';
          }
        } catch (e) {}
      }
      return diagnostics;
    };

    // Test DB Connectivity
    const testDbConnectivity = (mysqlContainerName, dbUser, dbPassword) => {
      return new Promise((resolve) => {
        if (!mysqlContainerName) {
          resolve({ status: 'error', message: 'MySQL container not found or stopped.' });
          return;
        }
        const user = dbUser || 'mypools';
        const pass = dbPassword || 'local-mypools';

        // Try mariadb first (MariaDB containers use mariadb binary), then mysql as fallback
        const tryCmd = (client, fallback) => {
          const cmd = `podman exec -i ${mysqlContainerName} ${client} -u"${user}" -p"${pass}" -e "SELECT 1;"`;
          exec(cmd, { timeout: 5000 }, (err, stdout, stderr) => {
            if (err) {
              const errMsg = (stderr || err.message || '').trim();
              if (fallback && (errMsg.includes('not found') || errMsg.includes('executable file'))) {
                // Try the fallback client
                tryCmd(fallback, null);
              } else {
                resolve({ status: 'error', message: errMsg });
              }
            } else {
              resolve({ status: 'ok', message: `Database connection verified (${client} client inside container).` });
            }
          });
        };

        tryCmd('mariadb', 'mysql');
      });
    };


    const lanIp = getLocalLanIp();
    
    let httpPort = '9080';
    let edgePort = '8443';
    try {
      const envPath = fs.existsSync(path.join(projectPath, '.env.local'))
        ? path.join(projectPath, '.env.local')
        : path.join(projectPath, '.env');
      if (fs.existsSync(envPath)) {
        const lines = fs.readFileSync(envPath, 'utf8').split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('APP_HTTP_PORT=')) {
            httpPort = trimmed.split('=')[1].trim().replace(/['"]/g, '');
          }
          if (trimmed.startsWith('EDGE_HTTPS_PORT=')) {
            edgePort = trimmed.split('=')[1].trim().replace(/['"]/g, '');
          }
        }
      }
    } catch (e) {}

    const getBackups = () => {
      const backupDir = path.join(projectPath, '.local', 'config-backups');
      if (!fs.existsSync(backupDir)) return [];
      try {
        return fs.readdirSync(backupDir)
          .filter(f => f.endsWith('.bak'))
          .map(file => {
            const stat = fs.statSync(path.join(backupDir, file));
            return {
              filename: file,
              size: stat.size,
              mtime: stat.mtime.toISOString()
            };
          })
          .sort((a, b) => b.mtime.localeCompare(a.mtime));
      } catch (e) {
        return [];
      }
    };

    checkContainers().then(({ parsed: containers }) => {
      const wpConfig = parseWpConfig();
      const nginxConfig = parseNginxConfig();
      
      const mysqlContainer = containers.mysql && containers.mysql.status === 'running' ? containers.mysql.name : null;
      
      const dbPromise = testDbConnectivity(mysqlContainer, wpConfig.data.dbUser, wpConfig.data.dbPassword);
      const homescreenPromise = verifyHomescreen(httpPort, edgePort, mysqlContainer, wpConfig.data.dbUser, wpConfig.data.dbPassword, wpConfig.data.dbName);
      const wordpressPromise = verifyWordPress(httpPort, edgePort, mysqlContainer, wpConfig.data.dbUser, wpConfig.data.dbPassword, wpConfig.data.dbName);
      const mediaThumbnailsPromise = verifyMediaThumbnails(projectPath, mysqlContainer, wpConfig.data.dbUser, wpConfig.data.dbPassword, wpConfig.data.dbName);

      Promise.all([dbPromise, homescreenPromise, wordpressPromise, mediaThumbnailsPromise]).then(([dbTest, homescreenTest, wordpressTest, mediaThumbnailsTest]) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          project: projectName,
          containers,
          diagnostics: {
            wpConfig: {
              exists: wpConfig.data.wpConfigExists,
              path: wpConfig.path,
              dbHost: wpConfig.data.dbHost,
              dbHostVal: wpConfig.data.dbHostVal,
              wpUrls: wpConfig.data.wpUrls,
              wpUrlsVal: wpConfig.data.wpUrlsVal
            },
            nginx: {
              exists: nginxConfig.nginxConfigExists,
              path: nginxConfig.path,
              upstream: nginxConfig.nginxUpstream,
              upstreamVal: nginxConfig.nginxUpstreamVal,
              hostHeader: nginxConfig.nginxHostHeader
            },
            dbConnectivity: dbTest,
            httpConnectivity: {
              homescreen: homescreenTest,
              wordpress: wordpressTest,
              mediaThumbnails: mediaThumbnailsTest
            }
          },
          network: {
            lanIp,
            httpPort,
            edgePort,
            paths: {
              directHttp: `http://127.0.0.1:${httpPort}/wp-admin/`,
              edgeHttps: `https://127.0.0.1:${edgePort}/wp-admin/`,
              lanHttp: `http://${lanIp}:${httpPort}/splash/`,
              lanHttps: `https://${lanIp}:${edgePort}/splash/`
            }
          },
          backups: getBackups()
        }));
      });
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Health check failed: ' + err.message }));
    });
    return;
  }

  // POST /api/local-health/fix
  if (pathname === '/api/local-health/fix' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const { project, type } = payload;
        
        const projectPath = getProjectPath(project);
        if (!projectPath || !fs.existsSync(projectPath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Project directory not found' }));
          return;
        }

        const handleSuccess = (msg) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: msg }));
        };

        const handleError = (msg) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: msg }));
        };

        if (type === 'wp-db-host') {
          const wpConfigPath = fs.existsSync(path.join(projectPath, 'secrets', 'wp-config.local.php'))
            ? path.join(projectPath, 'secrets', 'wp-config.local.php')
            : path.join(projectPath, 'wp-config.local.php');
          
          if (!fs.existsSync(wpConfigPath)) {
            handleError('wp-config.local.php not found.');
            return;
          }

          let content = fs.readFileSync(wpConfigPath, 'utf8');
          const originalContent = content;
          content = content.replace(/define\(\s*['"]DB_HOST['"]\s*,\s*['"]([^'"]+)['"]\s*\)/, "define( 'DB_HOST', 'mysql' )");
          
          if (content === originalContent) {
            handleError('Could not locate define( "DB_HOST", ... ) in configuration.');
            return;
          }

          fs.writeFileSync(wpConfigPath, content, 'utf8');
          handleSuccess('Successfully set DB_HOST to mysql.');
          return;
        }

        if (type === 'wp-dynamic-urls') {
          const wpConfigPath = fs.existsSync(path.join(projectPath, 'secrets', 'wp-config.local.php'))
            ? path.join(projectPath, 'secrets', 'wp-config.local.php')
            : path.join(projectPath, 'wp-config.local.php');
          
          if (!fs.existsSync(wpConfigPath)) {
            handleError('wp-config.local.php not found.');
            return;
          }

          let content = fs.readFileSync(wpConfigPath, 'utf8');
          
          const dynamicSnippet = `// Dynamic host resolution for local/LAN testing
$http_host = isset($_SERVER['HTTP_HOST']) ? $_SERVER['HTTP_HOST'] : '127.0.0.1:8443';
$scheme = (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] === 'on') ? 'https' : 'http';
if (strpos($http_host, ':9080') !== false) { $scheme = 'http'; }
define( 'WP_HOME', $scheme . '://' . $http_host );
define( 'WP_SITEURL', $scheme . '://' . $http_host );`;

          let replaced = false;
          content = content.replace(/define\(\s*['"]WP_HOME['"]\s*,\s*['"]([^'"]+)['"]\s*\);/g, '');
          content = content.replace(/define\(\s*['"]WP_SITEURL['"]\s*,\s*['"]([^'"]+)['"]\s*\);/g, '');
          content = content.replace(/\/\/ Parity with production: public URL is HTTPS at the edge[^\n]*\n/g, '');
          
          const insertMarker = '/* Add any custom values';
          if (content.includes(insertMarker)) {
            content = content.replace(insertMarker, `${dynamicSnippet}\n\n${insertMarker}`);
            replaced = true;
          } else {
            const fallbackMarker = 'require_once ABSPATH';
            if (content.includes(fallbackMarker)) {
              content = content.replace(fallbackMarker, `${dynamicSnippet}\n\n${fallbackMarker}`);
              replaced = true;
            }
          }

          if (!replaced) {
            handleError('Failed to patch wp-config.local.php with dynamic URLs.');
            return;
          }

          fs.writeFileSync(wpConfigPath, content, 'utf8');
          handleSuccess('Patched wp-config.local.php with dynamic URL resolution.');
          return;
        }

        if (type === 'nginx-upstream') {
          const edgeConfDir = path.join(projectPath, 'nginx', 'edge', 'conf.d');
          if (!fs.existsSync(edgeConfDir)) {
            handleError('Nginx edge config directory not found.');
            return;
          }

          const files = fs.readdirSync(edgeConfDir).filter(f => f.endsWith('.conf'));
          if (files.length === 0) {
            handleError('Nginx conf file not found.');
            return;
          }

          const confFile = path.join(edgeConfDir, files[0]);
          let content = fs.readFileSync(confFile, 'utf8');
          content = content.replace(/proxy_pass\s+[^;]+;/g, 'proxy_pass http://php:80;');
          
          fs.writeFileSync(confFile, content, 'utf8');
          handleSuccess('Set proxy_pass upstream to http://php:80.');
          return;
        }

        if (type === 'nginx-host-header') {
          const edgeConfDir = path.join(projectPath, 'nginx', 'edge', 'conf.d');
          if (!fs.existsSync(edgeConfDir)) {
            handleError('Nginx edge config directory not found.');
            return;
          }

          const files = fs.readdirSync(edgeConfDir).filter(f => f.endsWith('.conf'));
          if (files.length === 0) {
            handleError('Nginx conf file not found.');
            return;
          }

          const confFile = path.join(edgeConfDir, files[0]);
          let content = fs.readFileSync(confFile, 'utf8');
          
          if (content.includes('proxy_set_header Host')) {
            content = content.replace(/proxy_set_header Host\s+[^;]+;/g, 'proxy_set_header Host $http_host;');
          } else {
            content = content.replace(/location\s+\/\s+\{/g, 'location / {\n        proxy_set_header Host $http_host;');
          }

          fs.writeFileSync(confFile, content, 'utf8');
          handleSuccess('Ensured proxy_set_header Host is set to $http_host.');
          return;
        }

        if (type === 'heal-service') {
          const service = payload.service;
          if (!service || !/^[a-zA-Z0-9_\-]+$/.test(service)) {
            handleError('Invalid service name.');
            return;
          }

          if (activeTask.status === 'running') {
            handleError('Another task is running. Please wait.');
            return;
          }

          const envFile = fs.existsSync(path.join(projectPath, '.env.local')) ? '.env.local' : '.env';
          const composeFiles = `-f compose.yml ${fs.existsSync(path.join(projectPath, 'compose.edge.yml')) ? '-f compose.edge.yml' : ''}`;
          const upCmd = `podman-compose ${composeFiles} --env-file ${envFile} up -d ${service}`;

          activeTask.status = 'running';
          activeTask.type = 'deploy';
          activeTask.project = project;

          broadcast({ type: 'status', status: 'running', taskType: 'deploy', project: project });
          broadcast({ type: 'log', text: `>>> Healing/Starting service "${service}" for ${project}...\n`, stream: 'stdout' });
          broadcast({ type: 'log', text: `Executing: ${upCmd}\n`, stream: 'stdout' });

          exec(upCmd, { cwd: projectPath }, (upErr, upStdout, upStderr) => {
            activeTask.status = 'idle';
            activeTask.type = null;
            activeTask.project = null;
            broadcast({ type: 'status', status: 'idle', taskType: null, project: null });

            if (upErr) {
              broadcast({ type: 'log', text: `Failed to heal service: ${upStderr || upErr.message}\n`, stream: 'stderr' });
              broadcast({ type: 'done', code: 1 });
              handleError(`Healing failed: ${upStderr || upErr.message}`);
            } else {
              broadcast({ type: 'log', text: `Up: ${upStdout}\n`, stream: 'stdout' });
              broadcast({ type: 'log', text: `>>> Service "${service}" started successfully.\n`, stream: 'stdout' });
              broadcast({ type: 'done', code: 0 });
              handleSuccess(`Service "${service}" started successfully.`);
            }
          });
          return;
        }

        if (type === 'restart-stack') {
          if (activeTask.status === 'running') {
            handleError('Another task is running. Please wait.');
            return;
          }
          
          const envFile = fs.existsSync(path.join(projectPath, '.env.local')) ? '.env.local' : '.env';
          const composeFiles = `-f compose.yml ${fs.existsSync(path.join(projectPath, 'compose.edge.yml')) ? '-f compose.edge.yml' : ''}`;
          
          const downCmd = `podman-compose ${composeFiles} --env-file ${envFile} down`;
          const upCmd = `podman-compose ${composeFiles} --env-file ${envFile} up -d`;
          
          activeTask.status = 'running';
          activeTask.type = 'deploy';
          activeTask.project = project;

          broadcast({ type: 'status', status: 'running', taskType: 'deploy', project: project });
          broadcast({ type: 'log', text: `>>> Restarting Stack for ${project}...\n`, stream: 'stdout' });
          broadcast({ type: 'log', text: `Executing: ${downCmd}\n`, stream: 'stdout' });
          
          exec(downCmd, { cwd: projectPath }, (downErr, downStdout, downStderr) => {
            if (downErr) {
              broadcast({ type: 'log', text: `Warning down: ${downStderr || downErr.message}\n`, stream: 'stderr' });
            } else {
              broadcast({ type: 'log', text: `Down: ${downStdout}\n`, stream: 'stdout' });
            }
            
            broadcast({ type: 'log', text: `Executing: ${upCmd}\n`, stream: 'stdout' });
            exec(upCmd, { cwd: projectPath }, (upErr, upStdout, upStderr) => {
              activeTask.status = 'idle';
              activeTask.type = null;
              activeTask.project = null;
              broadcast({ type: 'status', status: 'idle', taskType: null, project: null });
              
              if (upErr) {
                broadcast({ type: 'log', text: `Failed to start stack: ${upStderr || upErr.message}\n`, stream: 'stderr' });
                broadcast({ type: 'done', code: 1 });
                handleError(`Restart failed: ${upStderr || upErr.message}`);
              } else {
                broadcast({ type: 'log', text: `Up: ${upStdout}\n`, stream: 'stdout' });
                broadcast({ type: 'log', text: `>>> Stack restarted successfully.\n`, stream: 'stdout' });
                broadcast({ type: 'done', code: 0 });
                handleSuccess('Stack restarted successfully.');
              }
            });
          });
          return;
        }

        if (type === 'wp-media-urls') {
          const wpConfigPath = fs.existsSync(path.join(projectPath, 'secrets', 'wp-config.local.php'))
            ? path.join(projectPath, 'secrets', 'wp-config.local.php')
            : path.join(projectPath, 'wp-config.local.php');
          
          if (!fs.existsSync(wpConfigPath)) {
            handleError('wp-config.local.php not found.');
            return;
          }

          const parseWpConfig = () => {
            const content = fs.readFileSync(wpConfigPath, 'utf8');
            const data = { dbUser: '', dbPassword: '', dbName: '' };
            const uMatch = content.match(/define\(\s*['"]DB_USER['"]\s*,\s*['"]([^'"]+)['"]\s*\)/);
            if (uMatch) data.dbUser = uMatch[1];
            const pMatch = content.match(/define\(\s*['"]DB_PASSWORD['"]\s*,\s*['"]([^'"]+)['"]\s*\)/);
            if (pMatch) data.dbPassword = pMatch[1];
            const nMatch = content.match(/define\(\s*['"]DB_NAME['"]\s*,\s*['"]([^'"]+)['"]\s*\)/);
            if (nMatch) data.dbName = nMatch[1];
            return data;
          };

          const wpConfigData = parseWpConfig();

          const containers = await new Promise((resolve) => {
            const localComposeProject = getComposeProjectName(projectPath, `${project}-local`);
            exec(`podman ps -a --filter label=io.podman.compose.project=${localComposeProject} --format "{{.Names}} ({{.Status}})"`, (err, stdout) => {
              if (err) resolve('');
              else resolve(stdout.trim());
            });
          });

          const mysqlMatch = containers.split('\n').find(line => line.toLowerCase().includes('_mysql_') || line.toLowerCase().endsWith('_mysql'));
          const mysqlContainer = mysqlMatch ? mysqlMatch.split(' ')[0] : null;

          if (!mysqlContainer) {
            handleError('MySQL container not running or not found.');
            return;
          }

          const dbRes = await getWordPressUrlFromDb(mysqlContainer, wpConfigData.dbUser, wpConfigData.dbPassword, wpConfigData.dbName);
          const replacementUrl = dbRes.ok ? dbRes.url.replace(/\/$/, '') : 'https://mypools.test';

          // 1. Write the updated mu-plugins
          const muDir = path.join(projectPath, 'wordpress', 'wp-content', 'mu-plugins');
          if (!fs.existsSync(muDir)) {
            fs.mkdirSync(muDir, { recursive: true });
          }

          try {
            writeMuPlugins(muDir);
          } catch (e) {
            handleError('Failed to write mu-plugins: ' + e.message);
            return;
          }

          // 2. Perform DB Replace
          const user = wpConfigData.dbUser || 'mypools';
          const pass = wpConfigData.dbPassword || 'local-mypools';
          const db = wpConfigData.dbName || 'mypools';

          const sql = `UPDATE wp_posts SET guid = REPLACE(guid, 'http://127.0.0.1:9082', '${replacementUrl}'); ` +
                      `UPDATE wp_posts SET guid = REPLACE(guid, 'https://127.0.0.1:9082', '${replacementUrl}'); ` +
                      `UPDATE wp_posts SET guid = REPLACE(guid, 'http://localhost:9082', '${replacementUrl}'); ` +
                      `UPDATE wp_posts SET guid = REPLACE(guid, 'https://localhost:9082', '${replacementUrl}'); ` +
                      `UPDATE wp_postmeta SET meta_value = REPLACE(meta_value, 'http://127.0.0.1:9082', '${replacementUrl}'); ` +
                      `UPDATE wp_postmeta SET meta_value = REPLACE(meta_value, 'https://127.0.0.1:9082', '${replacementUrl}'); ` +
                      `UPDATE wp_postmeta SET meta_value = REPLACE(meta_value, 'http://localhost:9082', '${replacementUrl}'); ` +
                      `UPDATE wp_postmeta SET meta_value = REPLACE(meta_value, 'https://localhost:9082', '${replacementUrl}');`;

          const tryCmd = (client, fallback) => {
            const cmd = `podman exec -i ${mysqlContainer} ${client} -u"${user}" -p"${pass}" -D "${db}" -e "${sql}"`;
            exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
              if (err) {
                const errMsg = (stderr || err.message || '').trim();
                if (fallback && (errMsg.includes('not found') || errMsg.includes('executable file'))) {
                  tryCmd(fallback, null);
                } else {
                  handleError(`Failed to update legacy URLs in database: ${errMsg}`);
                }
              } else {
                handleSuccess('WordPress media mu-plugins updated, and legacy :9082 URLs resolved in database.');
              }
            });
          };

          tryCmd('mariadb', 'mysql');
          return;
        }

        handleError('Invalid fix type.');
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Malformed JSON payload: ' + e.message }));
      }
    });
    return;
  }

  // GET /api/local-health/backups
  if (pathname === '/api/local-health/backups' && method === 'GET') {
    const project = parsedUrl.query.project;
    const filename = parsedUrl.query.filename;
    if (!project) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing project parameter' }));
      return;
    }
    const projectPath = getProjectPath(project);
    if (!projectPath || !fs.existsSync(projectPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Project directory not found' }));
      return;
    }

    const backupDir = path.join(projectPath, '.local', 'config-backups');
    if (filename) {
      const safeFilename = path.basename(filename);
      const backupPath = path.join(backupDir, safeFilename);
      if (!fs.existsSync(backupPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Backup file not found' }));
        return;
      }
      fs.readFile(backupPath, 'utf8', (err, data) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to read backup file' }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ filename: safeFilename, content: data }));
        }
      });
    } else {
      if (!fs.existsSync(backupDir)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ backups: [] }));
        return;
      }
      fs.readdir(backupDir, (err, files) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to list backups' }));
          return;
        }
        const backups = files
          .filter(f => f.endsWith('.bak'))
          .map(file => {
            const stat = fs.statSync(path.join(backupDir, file));
            return {
              filename: file,
              size: stat.size,
              mtime: stat.mtime.toISOString()
            };
          })
          .sort((a, b) => b.mtime.localeCompare(a.mtime));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ backups }));
      });
    }
    return;
  }

  // POST /api/local-health/backups/restore
  if (pathname === '/api/local-health/backups/restore' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { project, filename } = payload;

        if (!project || !filename) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing project or filename parameters' }));
          return;
        }

        const projectPath = getProjectPath(project);
        if (!projectPath || !fs.existsSync(projectPath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Project directory not found' }));
          return;
        }

        const backupDir = path.join(projectPath, '.local', 'config-backups');
        const safeFilename = path.basename(filename);
        const backupPath = path.join(backupDir, safeFilename);

        if (!fs.existsSync(backupPath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Backup file not found' }));
          return;
        }

        const filesToWatch = [
          '.env',
          '.env.local',
          'compose.yml',
          'compose.edge.yml',
          'nginx/edge/conf.d/mypools-edge.conf',
          'nginx/edge/conf.d/essop-edge.conf',
          'nginx/conf.d/mypools.conf',
          'nginx/conf.d/essop.conf',
          'secrets/wp-config.local.php'
        ];

        let originalRelPath = null;
        for (const relPath of filesToWatch) {
          const fileId = relPath.replace(/\\/g, '/').replace(/[^a-zA-Z0-9.\-_]/g, '_');
          if (safeFilename.startsWith(fileId + '_')) {
            originalRelPath = relPath;
            break;
          }
        }

        if (!originalRelPath) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Could not map backup to original file path' }));
          return;
        }

        const targetPath = path.join(projectPath, originalRelPath);
        const targetDir = path.dirname(targetPath);
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }

        fs.copyFile(backupPath, targetPath, (err) => {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to restore file: ' + err.message }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: `Successfully restored ${originalRelPath}` }));
          }
        });
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Malformed JSON payload: ' + e.message }));
      }
    });
    return;
  }

  // --- Static File Server ---
  if (method === 'GET') {
    let filePath = path.join(SNAPSHOTS_ROOT, 'public', pathname === '/' ? 'index.html' : pathname);

    // Resolve path to prevent directory traversal
    filePath = path.resolve(filePath);
    const publicDir = path.resolve(path.join(SNAPSHOTS_ROOT, 'public'));
    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    const extname = path.extname(filePath);
    let contentType = 'text/html';
    switch (extname) {
      case '.js':
        contentType = 'application/javascript';
        break;
      case '.css':
        contentType = 'text/css';
        break;
      case '.json':
        contentType = 'application/json';
        break;
      case '.png':
        contentType = 'image/png';
        break;
      case '.jpg':
        contentType = 'image/jpg';
        break;
      case '.svg':
        contentType = 'image/svg+xml';
        break;
    }

    fs.readFile(filePath, (error, content) => {
      if (error) {
        if (error.code === 'ENOENT') {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('404 Not Found');
        } else {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(`Server Error: ${error.code}`);
        }
      } else {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content, 'utf-8');
      }
    });
    return;
  }

  // Fallback 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('404 Not Found');
});

server.listen(PORT, () => {
  console.log(`Snapshot Recovery Panel Server running at http://localhost:${PORT}`);
  try {
    const projects = loadProjects();
    projects.forEach(p => {
      watchConfigChanges(p.path, p.name);
    });
  } catch (e) {
    console.error('Failed to initialize watchers at startup:', e);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[ERROR] Port ${PORT} is already in use. Another instance of the server may be running.`);
    console.error(`[ERROR] To find and kill the existing process, run:`);
    console.error(`[ERROR]   netstat -ano | findstr :${PORT}`);
    console.error(`[ERROR]   Stop-Process -Id <PID> -Force\n`);
    process.exit(1);
  } else {
    console.error('[ERROR] Server encountered an unexpected error:', err);
    process.exit(1);
  }
});
