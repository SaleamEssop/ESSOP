const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const url = require('url');

const PORT = 3050;
const SNAPSHOTS_ROOT = __dirname;
const PROJECTS_FILE = path.join(SNAPSHOTS_ROOT, 'projects.json');

function loadProjects() {
  if (!fs.existsSync(PROJECTS_FILE)) {
    const defaultProjects = [
      { name: path.basename(SNAPSHOTS_ROOT), path: SNAPSHOTS_ROOT }
    ];
    try {
      fs.mkdirSync(SNAPSHOTS_ROOT, { recursive: true });
      fs.writeFileSync(PROJECTS_FILE, JSON.stringify(defaultProjects, null, 2), 'utf8');
    } catch(e) {}
    return defaultProjects;
  }
  try {
    return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
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

// Run a PowerShell script in a child process
function runPowerShellScript(scriptFile, args) {
  if (activeTask.status === 'running') {
    throw new Error('Another task is already running');
  }

  activeTask.status = 'running';
  const isCreate = scriptFile.toLowerCase().includes('create');
  const isRestore = scriptFile.toLowerCase().includes('restore');
  activeTask.type = isCreate ? 'create' : (isRestore ? 'restore' : 'deploy');
  
  const projIdx = args.indexOf('-Project');
  const defaultProj = (loadProjects()[0] || { name: 'mypools' }).name;
  activeTask.project = projIdx !== -1 ? args[projIdx + 1] : (activeTask.type === 'deploy' ? defaultProj : 'unknown');
  
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
        let targetPath = payload.path ? payload.path.trim() : '';
        
        if (!targetPath) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Folder path is required.' }));
          return;
        }

        // Try to resolve path
        try {
          targetPath = path.resolve(targetPath);
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid folder path format.' }));
          return;
        }

        // Create folder recursively if it doesn't exist
        if (!fs.existsSync(targetPath)) {
          try {
            fs.mkdirSync(targetPath, { recursive: true });
          } catch (mkdirErr) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Folder path does not exist and could not be created: ${mkdirErr.message}` }));
            return;
          }
        }

        const stats = fs.statSync(targetPath);
        if (!stats.isDirectory()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Provided path is not a directory.' }));
          return;
        }

        // Use custom name if provided, otherwise fallback to folder basename
        let name = payload.name ? payload.name.trim() : '';
        if (!name) {
          name = path.basename(targetPath) || 'unknown';
        }

        if (!/^[a-zA-Z0-9_\-]+$/.test(name)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Project name contains invalid characters. Use alphanumeric, dash, or underscore.' }));
          return;
        }

        const projs = loadProjects();
        if (projs.some(p => p.name.toLowerCase() === name.toLowerCase())) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Project name "${name}" is already registered. Please specify a unique name.` }));
          return;
        }
        if (projs.some(p => p.path.toLowerCase() === targetPath.toLowerCase())) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Folder path is already registered under another project.' }));
          return;
        }

        projs.push({ name, path: targetPath });
        saveProjects(projs);

        // Make sure the project has a snapshots folder and a .local folder
        const snapsPath = path.join(targetPath, 'snapshots');
        if (!fs.existsSync(snapsPath)) {
          fs.mkdirSync(snapsPath, { recursive: true });
        }
        const localPath = path.join(targetPath, '.local');
        if (!fs.existsSync(localPath)) {
          fs.mkdirSync(localPath, { recursive: true });
        }

        // Trigger registry refresh
        const refreshScript = path.join(SNAPSHOTS_ROOT, 'Refresh-Registry.ps1');
        exec(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${refreshScript}"`, () => {
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

    // Trigger registry refresh
    const refreshScript = path.join(SNAPSHOTS_ROOT, 'Refresh-Registry.ps1');
    exec(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${refreshScript}"`, () => {
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
    const refreshScript = path.join(SNAPSHOTS_ROOT, 'Refresh-Registry.ps1');
    exec(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${refreshScript}"`, (err) => {
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
    const defaultProj = (loadProjects()[0] || { name: 'mypools' }).name;
    const project = parsedUrl.query.project || defaultProj;
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
        const { project, description, live, noDb, excludePaths } = payload;

        if (!project || !/^[a-zA-Z0-9_\-]+$/.test(project)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid or missing project name' }));
          return;
        }

        const args = ['-Project', project, '-Description', description || 'Manual snapshot'];
        if (live) args.push('-Live');
        if (noDb) args.push('-NoDatabase');
        if (excludePaths) {
          const excludesStr = Array.isArray(excludePaths) ? excludePaths.join(',') : excludePaths;
          if (excludesStr) {
            args.push('-ExcludePaths', excludesStr);
          }
        }
        const projectPath = getProjectPath(project);
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

        const defaultProj = (loadProjects()[0] || { name: 'mypools' }).name;
        const activeProject = project || defaultProj;
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
    const defaultProj = (loadProjects()[0] || { name: 'mypools' }).name;
    const project = parsedUrl.query.project || defaultProj;
    const localRepo = getProjectPath(project);
    if (!localRepo || !fs.existsSync(localRepo)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Project local repository not found' }));
      return;
    }
    const settingsPath = path.join(localRepo, '.local', 'settings.json');
    const secretPath = path.join(localRepo, '.local', 'ssh.secret.txt');

    const isMyPools = project.toLowerCase() === 'mypools';
    let settings = {
      sshHost: isMyPools ? '152.42.220.5' : '152.42.220.6',
      sshUser: 'root',
      sshPassword: '',
      sshHostKey: isMyPools 
        ? 'SHA256:ZJmY20MEfjIPQ9I3uWA4Thql8y70nQxjY6za9LMiDBg' 
        : 'SHA256:ai+BPKWKn3SjOimurq2kf9HK60XZluOMSWEFiINKMLk',
      gitRepo: localRepo,
      gitBranch: 'main',
      siteUrl: isMyPools ? 'https://mypools.co.za' : `https://${project.toLowerCase()}.co.za`
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
    const siteUrl = settings.siteUrl || (isMyPools ? 'https://mypools.co.za' : `https://${project.toLowerCase()}.co.za`);
    const siteDomain = url.parse(siteUrl).hostname || (isMyPools ? 'mypools.co.za' : `${project.toLowerCase()}.co.za`);
    const vpsInstallRoot = settings.vpsInstallRoot || `/opt/${project.toLowerCase()}`;

    // Function to run SSH command via plink
    const runSsh = (cmd) => {
      return new Promise((resolve) => {
        const plinkTool = fs.existsSync(path.join(localRepo, 'tools', 'plink.exe')) 
          ? path.join(localRepo, 'tools', 'plink.exe') 
          : (fs.existsSync(path.join(SNAPSHOTS_ROOT, 'tools', 'plink.exe')) ? path.join(SNAPSHOTS_ROOT, 'tools', 'plink.exe') : 'plink.exe');
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

    // Helper to fetch URL
    const fetchUrl = (url) => {
      return new Promise((resolve) => {
        const start = Date.now();
        const lib = url.startsWith('https') ? require('https') : require('http');
        
        const req = lib.get(url, { headers: { 'User-Agent': 'Snapshot-Console-Health-Checker' } }, (res) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            resolve({
              status: res.statusCode,
              responseTime: Date.now() - start,
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
        
        req.setTimeout(8000, () => {
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
    const defaultProj = (loadProjects()[0] || { name: 'mypools' }).name;
    const project = parsedUrl.query.project || defaultProj;
    const localRepo = getProjectPath(project);
    if (!localRepo || !fs.existsSync(localRepo)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Project directory not found' }));
      return;
    }
    const settingsPath = path.join(localRepo, '.local', 'settings.json');
    const secretPath = path.join(localRepo, '.local', 'ssh.secret.txt');

    const isMyPools = project.toLowerCase() === 'mypools';
    let settings = {
      sshHost: isMyPools ? '152.42.220.5' : '152.42.220.6',
      sshUser: 'root',
      sshPassword: '',
      sshHostKey: isMyPools 
        ? 'SHA256:ZJmY20MEfjIPQ9I3uWA4Thql8y70nQxjY6za9LMiDBg' 
        : 'SHA256:ai+BPKWKn3SjOimurq2kf9HK60XZluOMSWEFiINKMLk',
      gitRepo: localRepo,
      gitBranch: 'main',
      siteUrl: isMyPools ? 'https://mypools.co.za' : `https://${project.toLowerCase()}.co.za`,
      vpsInstallRoot: `/opt/${project.toLowerCase()}`
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
        const { project, sshHost, sshUser, sshPassword, sshHostKey, gitBranch, siteUrl, vpsInstallRoot } = payload;

        const defaultProj = (loadProjects()[0] || { name: 'mypools' }).name;
        const activeProject = project || defaultProj;
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

        const isMyPools = activeProject.toLowerCase() === 'mypools';
        const settings = {
          sshHost: sshHost || (isMyPools ? '152.42.220.5' : '152.42.220.6'),
          sshUser: sshUser || 'root',
          sshPassword: sshPassword || '',
          sshHostKey: sshHostKey || (isMyPools 
            ? 'SHA256:ZJmY20MEfjIPQ9I3uWA4Thql8y70nQxjY6za9LMiDBg' 
            : 'SHA256:ai+BPKWKn3SjOimurq2kf9HK60XZluOMSWEFiINKMLk'),
          gitRepo: localRepo,
          gitBranch: gitBranch || 'main',
          siteUrl: siteUrl || (isMyPools ? 'https://mypools.co.za' : `https://${activeProject.toLowerCase()}.co.za`),
          vpsInstallRoot: vpsInstallRoot || `/opt/${activeProject.toLowerCase()}`
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
    let snapsDir = 'snapshots';
    if (!fs.existsSync(path.join(projectPath, 'snapshots', name)) && fs.existsSync(path.join(projectPath, '.snapshots', name))) {
      snapsDir = '.snapshots';
    }
    const targetDir = path.join(projectPath, snapsDir, name);

    // Safety check: ensure targetDir is within projectPath\snapshots or projectPath\.snapshots
    const resolvedPath = path.resolve(targetDir);
    const expectedPrefix = path.resolve(path.join(projectPath, snapsDir));
    if (!resolvedPath.startsWith(expectedPrefix)) {
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
      const refreshScript = path.join(SNAPSHOTS_ROOT, 'Refresh-Registry.ps1');
      exec(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${refreshScript}"`, (refreshErr) => {
        if (refreshErr) {
          console.error('Refresh-Registry.ps1 failed after delete', refreshErr);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: `Snapshot ${name} deleted successfully` }));
      });
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
});
