// Global UI States
let projects = [];
let currentProject = '';
let snapshots = [];
let activeTask = { status: 'idle', type: null, project: null };
let activeRestoreSnapshot = null;
let activeDeleteSnapshot = null;
let sseSource = null;
let projectFiles = [];
const excludedPaths = new Set();

// DOM Elements - Selector Registry
const projectSelect = document.getElementById('project-select');
const addProjectBtn = document.getElementById('add-project-btn');
const deleteProjectBtn = document.getElementById('delete-project-btn');
const addProjectModal = document.getElementById('add-project-modal');
const cancelAddProjectBtn = document.getElementById('cancel-add-project-btn');
const confirmAddProjectBtn = document.getElementById('confirm-add-project-btn');
const newProjectPath = document.getElementById('new-project-path');
const newProjectName = document.getElementById('new-project-name');
const currentTabTitle = document.getElementById('current-tab-title');
const navItems = document.querySelectorAll('.nav-item');
const tabPanels = document.querySelectorAll('.tab-panel');

// Settings Tab DOM Elements
const settingsForm = document.getElementById('settings-form');
const settingsSshHost = document.getElementById('settings-ssh-host');
const settingsSshUser = document.getElementById('settings-ssh-user');
const settingsSshPassword = document.getElementById('settings-ssh-password');
const settingsSshHostkey = document.getElementById('settings-ssh-hostkey');
const settingsGitRepo = document.getElementById('settings-git-repo');
const settingsGitBranch = document.getElementById('settings-git-branch');
const settingsSiteUrl = document.getElementById('settings-site-url');
const settingsVpsRoot = document.getElementById('settings-vps-root');
const settingsSaveBtn = document.getElementById('settings-save-btn');

// Git Deployment Tab DOM Elements
const gitRefreshBtn = document.getElementById('git-refresh-btn');
const gitBranchVal = document.getElementById('git-branch-val');
const gitModifiedCount = document.getElementById('git-modified-count');
const gitUntrackedCount = document.getElementById('git-untracked-count');
const gitFilesContainer = document.getElementById('git-files-container');
const gitDeployForm = document.getElementById('git-deploy-form');
const gitCommitMessage = document.getElementById('git-commit-message');
const gitDeployBtn = document.getElementById('git-deploy-btn');
const gitStepper = document.getElementById('git-stepper');
const gitOverwriteDb = document.getElementById('git-overwrite-db');
const gitDbConfirmGroup = document.getElementById('git-db-confirm-group');
const gitDbConfirmInput = document.getElementById('git-db-confirm-input');

// Stepper Step Elements
const stepGitCommit = document.getElementById('step-git-commit');
const stepGitPush   = document.getElementById('step-git-push');
const stepGitScp    = document.getElementById('step-git-scp');
const stepGitCicd   = document.getElementById('step-git-cicd');
const stepGitVerify = document.getElementById('step-git-verify');

// Overview Tab Metrics
const overviewDir = document.getElementById('overview-dir');
const overviewCount = document.getElementById('overview-count');
const overviewLatest = document.getElementById('overview-latest');
const overviewComposeName = document.getElementById('overview-compose-name');

// Overview Tab Form
const overviewRapidForm = document.getElementById('overview-rapid-form');
const rapidDescInput = document.getElementById('rapid-desc');
const rapidLiveCheck = document.getElementById('rapid-live');
const rapidNoDbCheck = document.getElementById('rapid-nodb');

// Snapshots Tab
const snapshotsGridBody = document.getElementById('snapshots-grid-body');
const refreshSnapshotsBtn = document.getElementById('refresh-snapshots-btn');

// Explorer Tab
const explorerItemsContainer = document.getElementById('explorer-items-container');
const explorerSelectAll = document.getElementById('explorer-select-all');
const explorerDeselectAll = document.getElementById('explorer-deselect-all');
const excludesBadgesContainer = document.getElementById('excludes-badges-container');
const emptyExcludesLabel = document.getElementById('empty-excludes-label');

const explorerSnapshotForm = document.getElementById('explorer-snapshot-form');
const explorerDescInput = document.getElementById('explorer-desc');
const explorerLiveCheck = document.getElementById('explorer-live');
const explorerNoDbCheck = document.getElementById('explorer-nodb');
const explorerSubmitBtn = document.getElementById('explorer-submit-btn');

// Terminal Tab
const terminalOutputPre = document.getElementById('terminal-output-pre');
const terminalClearBtn = document.getElementById('terminal-clear-btn');

// Health & Parity Tab
const runParityBtn = document.getElementById('run-parity-btn');
const parityLoading = document.getElementById('parity-loading');
const parityEmpty = document.getElementById('parity-empty');
const parityResults = document.getElementById('parity-results');
const parityMetrics = document.getElementById('parity-metrics');

const valGitSync = document.getElementById('val-git-sync');
const valSiteStatus = document.getElementById('val-site-status');
const valSslStatus = document.getElementById('val-ssl-status');
const valSecurityStatus = document.getElementById('val-security-status');

const parityContainersTbody = document.getElementById('parity-containers-tbody');
const parityEndpointsTbody = document.getElementById('parity-endpoints-tbody');

const diagPortLeak = document.getElementById('diag-port-leak');
const diagDbHealth = document.getElementById('diag-db-health');
const diagSslDomain = document.getElementById('diag-ssl-domain');
const diagSslIssuer = document.getElementById('diag-ssl-issuer');
const diagSslExpiry = document.getElementById('diag-ssl-expiry');

const diagSysDisk = document.getElementById('diag-sys-disk');
const diagSysRam = document.getElementById('diag-sys-ram');
const diagSysCpu = document.getElementById('diag-sys-cpu');
const diagGitLocalCommit = document.getElementById('diag-git-local-commit');
const diagGitVpsCommit = document.getElementById('diag-git-vps-commit');

// Mini Console components
const miniConsole = document.getElementById('mini-console');
const miniConsoleHeader = document.getElementById('mini-console-header');
const miniConsoleDot = document.getElementById('mini-console-dot');
const miniConsoleTitle = document.getElementById('mini-console-title');
const miniConsolePre = document.getElementById('mini-console-pre');

// Modals
const restoreModal = document.getElementById('restore-modal');
const modalRestoreProject = document.getElementById('modal-restore-project');
const modalRestoreId = document.getElementById('modal-restore-id');
const modalRestoreDesc = document.getElementById('modal-restore-desc');
const modalRestoreTime = document.getElementById('modal-restore-time');
const restoreConfirmInput = document.getElementById('restore-confirm-input');
const cancelRestoreBtn = document.getElementById('cancel-restore-btn');
const confirmRestoreBtn = document.getElementById('confirm-restore-btn');
const modalRestoreSkipBackup = document.getElementById('modal-restore-skip-backup');

const deleteModal = document.getElementById('delete-modal');
const modalDeleteId = document.getElementById('modal-delete-id');
const modalDeleteDesc = document.getElementById('modal-delete-desc');
const cancelDeleteBtn = document.getElementById('cancel-delete-btn');
const confirmDeleteBtn = document.getElementById('confirm-delete-btn');

const toastContainer = document.getElementById('toast-container');

// --- Helper: Format Relative Time ---
function getRelativeTime(timestamp) {
  if (!timestamp) return 'Never';
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay === 1) return 'Yesterday';
  if (diffDay < 7) return `${diffDay} days ago`;
  
  return date.toISOString().split('T')[0];
}

// --- Helper: Format Absolute Date ---
function getAbsoluteTime(timestamp) {
  if (!timestamp) return '-';
  const date = new Date(timestamp);
  return date.toLocaleString();
}

// --- Helper: Show Toast Notification ---
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-content">${message}</span>
    <button class="toast-close">&times;</button>
  `;

  toastContainer.appendChild(toast);

  // Close event listener
  toast.querySelector('.toast-close').addEventListener('click', () => {
    toast.remove();
  });

  // Auto remove
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-10px)';
    setTimeout(() => toast.remove(), 200);
  }, 4000);
}

// --- Console Log Writer (Writes to Full and Docked Mini Consoles) ---
function appendConsoleLog(text, stream = 'stdout') {
  // Check for progress match e.g. [PROGRESS] 45%
  const progressMatch = text.match(/\[PROGRESS\]\s+(\d+)%/i);
  if (progressMatch) {
    const pct = parseInt(progressMatch[1], 10);
    updateProgress(pct);
    return; // Hide progress metadata from the terminal log stream to keep it clean
  }

  // Update stepper if active task is deployment
  if (activeTask.type === 'deploy' || lastTaskType === 'deploy') {
    updateStepperFromLog(text);
  }

  // Determine custom color classes based on content keywords
  let className = stream === 'stdout' ? 'console-log-stdout' : 'console-log-stderr';

  if (text.includes('[Restoring State ....]') || text.includes('Restoring State ....')) {
    className = 'console-log-restoring';
  } else if (text.includes('Doing this') || text.includes('>>> [STEP')) {
    className = 'console-log-doing';
  } else if (text.includes('[Recovery State Completed...]') || text.includes('Recovery State Completed')) {
    className = 'console-log-completed';
  } else if (text.includes('SUCCESS') || text.includes('successful') || text.includes('successfully') || text.includes('Success')) {
    className = 'console-log-success';
  } else if (text.includes('FAILED') || text.includes('failed') || text.includes('Failed') || text.includes('error') || text.includes('Error')) {
    // Only map to error class if it's not a normal stdout stream that happened to contain the word
    if (stream === 'stderr' || text.includes('FAILED') || text.includes('failed to start') || text.includes('failed:')) {
      className = 'console-log-error';
    }
  } else if (text.includes('WARNING') || text.includes('Warning') || text.includes('warning')) {
    className = 'console-log-warning';
  } else if (text.includes('>>> Starting') || text.includes('>>> Operation')) {
    className = 'console-log-info';
  }

  // Add to Full tab pre
  if (terminalOutputPre.textContent === 'Console is ready. Executed actions will stream output logs here...') {
    terminalOutputPre.textContent = '';
  }
  const spanFull = document.createElement('span');
  spanFull.className = className;
  spanFull.textContent = text;
  terminalOutputPre.appendChild(spanFull);

  // Buffer optimization: Keep at most 1000 logs in full terminal
  while (terminalOutputPre.children.length > 1000) {
    terminalOutputPre.removeChild(terminalOutputPre.firstChild);
  }

  // Scroll to bottom of full terminal container
  const terminalBody = terminalOutputPre.parentElement;
  if (terminalBody) {
    terminalBody.scrollTop = terminalBody.scrollHeight;
  }

  // Add to docked mini console pre
  if (miniConsolePre.textContent === 'Waiting for operations...') {
    miniConsolePre.textContent = '';
  }
  const spanMini = document.createElement('span');
  spanMini.className = className;
  spanMini.textContent = text;
  miniConsolePre.appendChild(spanMini);

  // Buffer optimization: Keep at most 150 logs in mini console
  while (miniConsolePre.children.length > 150) {
    miniConsolePre.removeChild(miniConsolePre.firstChild);
  }

  // Scroll to bottom of mini console body
  const miniBody = miniConsolePre.parentElement;
  if (miniBody) {
    miniBody.scrollTop = miniBody.scrollHeight;
  }
}

// --- Update UI Progress Bars ---
function updateProgress(pct) {
  const sidebarProgressText = document.getElementById('sidebar-progress-text');
  const sidebarProgressContainer = document.getElementById('sidebar-progress-container');
  const sidebarProgressFill = document.getElementById('sidebar-progress-fill');
  
  const miniProgressText = document.getElementById('mini-progress-text');
  const miniProgressContainer = document.getElementById('mini-progress-container');
  const miniProgressFill = document.getElementById('mini-progress-fill');
  
  const terminalProgressText = document.getElementById('terminal-progress-text');
  const terminalProgressContainer = document.getElementById('terminal-progress-container');
  const terminalProgressFill = document.getElementById('terminal-progress-fill');

  // Display containers
  if (sidebarProgressContainer) sidebarProgressContainer.style.display = 'block';
  if (miniProgressContainer) miniProgressContainer.style.display = 'block';
  if (terminalProgressContainer) terminalProgressContainer.style.display = 'block';

  // Set numeric percentage text labels
  if (sidebarProgressText) {
    sidebarProgressText.style.display = 'inline';
    sidebarProgressText.textContent = `${pct}%`;
  }
  if (miniProgressText) {
    miniProgressText.style.display = 'inline';
    miniProgressText.textContent = `${pct}%`;
  }
  if (terminalProgressText) {
    terminalProgressText.style.display = 'inline';
    terminalProgressText.textContent = `${pct}%`;
  }

  // Animate widths
  if (sidebarProgressFill) sidebarProgressFill.style.width = `${pct}%`;
  if (miniProgressFill) miniProgressFill.style.width = `${pct}%`;
  if (terminalProgressFill) terminalProgressFill.style.width = `${pct}%`;
}

// --- Hide and Reset Progress Bars ---
function hideProgress() {
  const sidebarProgressText = document.getElementById('sidebar-progress-text');
  const sidebarProgressContainer = document.getElementById('sidebar-progress-container');
  const sidebarProgressFill = document.getElementById('sidebar-progress-fill');
  
  const miniProgressText = document.getElementById('mini-progress-text');
  const miniProgressContainer = document.getElementById('mini-progress-container');
  const miniProgressFill = document.getElementById('mini-progress-fill');
  
  const terminalProgressText = document.getElementById('terminal-progress-text');
  const terminalProgressContainer = document.getElementById('terminal-progress-container');
  const terminalProgressFill = document.getElementById('terminal-progress-fill');

  if (sidebarProgressContainer) sidebarProgressContainer.style.display = 'none';
  if (sidebarProgressText) sidebarProgressText.style.display = 'none';
  if (sidebarProgressFill) sidebarProgressFill.style.width = '0%';
  
  if (miniProgressContainer) miniProgressContainer.style.display = 'none';
  if (miniProgressText) miniProgressText.style.display = 'none';
  if (miniProgressFill) miniProgressFill.style.width = '0%';
  
  if (terminalProgressContainer) terminalProgressContainer.style.display = 'none';
  if (terminalProgressText) terminalProgressText.style.display = 'none';
  if (terminalProgressFill) terminalProgressFill.style.width = '0%';
}

// --- Tab Navigation Setup ---
navItems.forEach(item => {
  item.addEventListener('click', () => {
    const targetTab = item.getAttribute('data-tab');
    
    // Toggle navigation button highlight
    navItems.forEach(nav => nav.classList.remove('active'));
    item.classList.add('active');
    
    // Toggle tab panels visibility
    tabPanels.forEach(panel => {
      if (panel.id === `tab-${targetTab}`) {
        panel.classList.add('active');
      } else {
        panel.classList.remove('active');
      }
    });
    
    // Update breadcrumbs current section text
    currentTabTitle.textContent = item.textContent.trim();

    // Fetch tab-specific data
    if (targetTab === 'settings') {
      loadSettings();
    } else if (targetTab === 'git') {
      loadGitStatus();
    }
  });
});

// --- Fetch API: Load Projects ---
async function loadProjects() {
  try {
    const response = await fetch('/api/projects');
    const data = await response.json();
    projects = data.projects || [];
    
    // Populate environment select element
    projectSelect.innerHTML = '';
    projects.forEach(p => {
      const option = document.createElement('option');
      option.value = p;
      option.textContent = p;
      projectSelect.appendChild(option);
    });

    if (projects.length > 0) {
      if (!currentProject || !projects.includes(currentProject)) {
        currentProject = projects[0];
      }
      projectSelect.value = currentProject;
      await loadProjectSnapshots(currentProject);
      await loadProjectFiles(currentProject);
      await loadSettings();
      await loadGitStatus();
    } else {
      currentProject = '';
      overviewDir.textContent = 'None';
      overviewComposeName.textContent = '-';
      overviewCount.textContent = '0';
      overviewLatest.textContent = 'Never';
      renderEmptyState();
    }
  } catch (err) {
    showToast('Failed to load environment projects list.', 'error');
  }
}

// --- Fetch API: Load Snapshots for Project ---
async function loadProjectSnapshots(project) {
  snapshotsGridBody.innerHTML = `
    <tr>
      <td colspan="7" class="loading-state">
        <div class="spinner"></div>
        Loading snapshots registry...
      </td>
    </tr>
  `;

  try {
    const response = await fetch(`/api/snapshots?project=${project}`);
    if (!response.ok) throw new Error('API Error');
    const data = await response.json();
    
    // Update active project info panels
    overviewDir.textContent = data.source_path || 'C:\\Podman\\' + project;
    overviewComposeName.textContent = project + '-local';
    overviewCount.textContent = (data.snapshots || []).length;
    
    snapshots = data.snapshots || [];
    if (snapshots.length > 0) {
      overviewLatest.textContent = getRelativeTime(snapshots[0].timestamp);
      renderSnapshotsTable();
    } else {
      overviewLatest.textContent = 'Never';
      renderEmptyState();
    }

    // Populate git snapshot select dropdown (must select a snapshot, remove current-local)
    const gitSelect = document.getElementById('git-snapshot-select');
    if (gitSelect) {
      gitSelect.innerHTML = '<option value="">-- Select a recovery snapshot --</option>';
      snapshots.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.name;
        opt.textContent = `${s.name} (${s.description || 'No description'})`;
        gitSelect.appendChild(opt);
      });
      validateGitForm();
    }
  } catch (err) {
    showToast('Failed to fetch snapshots registry.', 'error');
    renderErrorState();
  }
}

// --- Render Snapshots Table Registry ---
function renderSnapshotsTable() {
  snapshotsGridBody.innerHTML = '';
  snapshots.forEach((snap, idx) => {
    const tr = document.createElement('tr');
    if (idx === 0) {
      tr.className = 'latest-snapshot';
    }

    const typeBadge = snap.powered_off
      ? '<span class="badge badge-success">Consistent</span>'
      : '<span class="badge badge-warning">Live</span>';

    const dbBadge = snap.database_included
      ? '<span class="badge badge-teal">Included</span>'
      : '<span class="badge badge-muted">None</span>';

    const filesBadge = snap.files_included
      ? `<span class="badge badge-teal" title="${snap.files_count} files">Included</span>`
      : '<span class="badge badge-muted">None</span>';

    const gitCommit = snap.git_commit && snap.git_commit !== 'unknown'
      ? `<div class="git-branch">${snap.git_branch}</div><span class="git-code">${snap.git_commit}</span>`
      : '<span class="text-muted">-</span>';

    tr.innerHTML = `
      <td>
        <div class="time-col">
          <span class="time-relative">${getRelativeTime(snap.timestamp)}</span>
          <span class="time-absolute">${getAbsoluteTime(snap.timestamp)}</span>
        </div>
      </td>
      <td>
        <div class="desc-text" title="${snap.description}">${snap.description}</div>
      </td>
      <td>${typeBadge}</td>
      <td>${dbBadge}</td>
      <td>${filesBadge}</td>
      <td>${gitCommit}</td>
      <td class="actions-col">
        <button class="btn-text-primary restore-btn-trigger">Restore</button>
        <button class="btn-text-danger delete-btn-trigger">Delete</button>
      </td>
    `;

    // Bind event handlers for action links
    tr.querySelector('.restore-btn-trigger').addEventListener('click', () => triggerRestoreConfirm(snap));
    tr.querySelector('.delete-btn-trigger').addEventListener('click', () => triggerDeleteConfirm(snap));

    snapshotsGridBody.appendChild(tr);
  });
}

function renderEmptyState() {
  snapshotsGridBody.innerHTML = `
    <tr>
      <td colspan="7" class="empty-state">
        <svg viewBox="0 0 24 24" width="48" height="48" class="empty-state-icon">
          <path fill="currentColor" d="M12,4A4,4 0 0,1 16,8A4,4 0 0,1 12,12A4,4 0 0,1 8,8A4,4 0 0,1 12,4M12,14C16.42,14 20,15.79 20,18V20H4V18C4,15.79 7.58,14 12,14Z"/>
        </svg>
        <p>No recovery snapshots found for project <strong>${currentProject}</strong>.</p>
        <p style="font-size: 12px; margin-top: 4px;">Use the sidebar or rapid snapshot panel to create one.</p>
      </td>
    </tr>
  `;
}

function renderErrorState() {
  snapshotsGridBody.innerHTML = `
    <tr>
      <td colspan="7" class="empty-state">
        <p class="text-danger"><strong>Error: Could not retrieve snapshots registry.</strong></p>
        <p style="font-size: 12px; margin-top: 4px;">Check console logs or verify the local server is operating correctly.</p>
      </td>
    </tr>
  `;
}

// --- Fetch API: Load settings & SSH Credentials ---
async function loadSettings() {
  if (!currentProject) return;
  try {
    const response = await fetch(`/api/settings?project=${currentProject}`);
    if (!response.ok) throw new Error('Failed to fetch settings');
    const settings = await response.json();
    
    if (settingsSshHost) settingsSshHost.value = settings.sshHost || '';
    if (settingsSshUser) settingsSshUser.value = settings.sshUser || '';
    if (settingsSshPassword) settingsSshPassword.value = settings.sshPassword || '';
    if (settingsSshHostkey) settingsSshHostkey.value = settings.sshHostKey || '';
    if (settingsGitRepo) settingsGitRepo.value = settings.gitRepo || '';
    if (settingsGitBranch) settingsGitBranch.value = settings.gitBranch || '';
    if (settingsSiteUrl) settingsSiteUrl.value = settings.siteUrl || '';
    if (settingsVpsRoot) settingsVpsRoot.value = settings.vpsInstallRoot || '';
  } catch (err) {
    showToast('Failed to load settings & credentials.', 'error');
  }
}

// --- Fetch API: Load git status ---
async function loadGitStatus() {
  if (!currentProject) return;
  if (!gitFilesContainer) return;
  gitFilesContainer.innerHTML = `
    <li class="git-empty-state">
      <div class="spinner" style="width: 20px; height: 20px; margin: 0 auto 10px auto;"></div>
      Checking git status...
    </li>
  `;
  if (gitModifiedCount) gitModifiedCount.textContent = '0';
  if (gitUntrackedCount) gitUntrackedCount.textContent = '0';
  if (gitBranchVal) gitBranchVal.textContent = '-';

  try {
    const response = await fetch(`/api/git/status?project=${currentProject}`);
    if (!response.ok) throw new Error('API Error');
    const data = await response.json();

    if (gitBranchVal) gitBranchVal.textContent = data.branch || 'main';
    if (gitModifiedCount) gitModifiedCount.textContent = data.modifiedCount || '0';
    if (gitUntrackedCount) gitUntrackedCount.textContent = data.untrackedCount || '0';

    gitFilesContainer.innerHTML = '';
    if (!data.files || data.files.length === 0) {
      gitFilesContainer.innerHTML = '<li class="git-empty-state">No modified or untracked files. Working directory clean.</li>';
      return;
    }

    data.files.forEach(file => {
      const li = document.createElement('li');
      li.className = 'git-file-item';
      
      const isUntracked = file.status === '??';
      const badgeClass = isUntracked ? 'status-badge-untracked' : 'status-badge-modified';
      const badgeLabel = isUntracked ? 'Untracked' : 'Modified';

      li.innerHTML = `
        <span class="git-file-name">${file.filePath}</span>
        <span class="git-file-status ${badgeClass}">${badgeLabel}</span>
      `;
      gitFilesContainer.appendChild(li);
    });
  } catch (err) {
    gitFilesContainer.innerHTML = `
      <li class="git-empty-state text-danger">
        Failed to fetch repository status. Ensure settings point to a valid git repository.
      </li>
    `;
    showToast('Failed to retrieve git status.', 'error');
  }
}

// --- Stepper Controls helper ---
function resetStepper() {
  const steps = [stepGitCommit, stepGitPush, stepGitScp, stepGitCicd, stepGitVerify];
  steps.forEach(step => {
    if (step) step.className = 'monitor-step step-pending';
  });
}

function setStepStatus(stepElement, status) {
  if (!stepElement) return;
  stepElement.className = `monitor-step step-${status}`;
}

function updateStepperFromLog(text) {
  // STEP 1/5 — Local Commit
  if (text.includes('[STEP 1/5]')) {
    setStepStatus(stepGitCommit, 'running');
  } else if (text.includes('Changes committed successfully') || text.includes('Working tree clean')) {
    setStepStatus(stepGitCommit, 'completed');
  }
  // STEP 2/5 — Push
  else if (text.includes('[STEP 2/5]')) {
    setStepStatus(stepGitCommit, 'completed');
    setStepStatus(stepGitPush, 'running');
  } else if (text.includes('Successfully pushed to GitHub') || text.includes('GitHub remote is already up to date')) {
    setStepStatus(stepGitPush, 'completed');
  }
  // STEP 3/5 — SCP Snapshot
  else if (text.includes('[STEP 3/5]')) {
    setStepStatus(stepGitCommit, 'completed');
    setStepStatus(stepGitPush, 'completed');
    setStepStatus(stepGitScp, 'running');
  } else if (text.includes('Normal deploy') && text.includes('stale database')) {
    // Normal deploy — SCP step is a no-op, mark skipped (completed immediately)
    setStepStatus(stepGitScp, 'completed');
  } else if (text.includes('Snapshot uploaded to VPS successfully')) {
    setStepStatus(stepGitScp, 'completed');
  } else if (text.includes('SCP upload failed')) {
    setStepStatus(stepGitScp, 'failed');
  }
  // STEP 4/5 — CI/CD
  else if (text.includes('[STEP 4/5]')) {
    setStepStatus(stepGitCommit, 'completed');
    setStepStatus(stepGitPush, 'completed');
    setStepStatus(stepGitScp, 'completed');
    setStepStatus(stepGitCicd, 'running');
  } else if (text.includes('SUCCESS: VPS code has fully deployed')) {
    setStepStatus(stepGitCicd, 'completed');
  }
  // STEP 5/5 — Health & Parity
  else if (text.includes('[STEP 5/5]')) {
    setStepStatus(stepGitCommit, 'completed');
    setStepStatus(stepGitPush, 'completed');
    setStepStatus(stepGitScp, 'completed');
    setStepStatus(stepGitCicd, 'completed');
    setStepStatus(stepGitVerify, 'running');
  } else if (text.includes('[Recovery State Completed...]')) {
    setStepStatus(stepGitVerify, 'completed');
  } else if (text.includes('[Recovery State Completed with warnings...]')) {
    setStepStatus(stepGitVerify, 'failed');
  }
}

// --- Fetch API: Load Project Directory Files for Exclusion Explorer ---
async function loadProjectFiles(project) {
  explorerItemsContainer.innerHTML = `
    <div class="loading-state">
      <div class="spinner"></div>
      Reading project structure...
    </div>
  `;

  excludedPaths.clear();
  renderExclusionsSummary();

  try {
    const response = await fetch(`/api/project/files?project=${project}`);
    if (!response.ok) throw new Error('API Error');
    const data = await response.json();
    
    projectFiles = data.items || [];
    renderProjectFiles();
  } catch (err) {
    explorerItemsContainer.innerHTML = `
      <div class="loading-state text-danger">
        <p>Failed to retrieve directory structure.</p>
        <p style="font-size: 12px; margin-top: 4px;">Make sure the project source folder exists on disk.</p>
      </div>
    `;
    showToast('Failed to load project directory structure.', 'error');
  }
}

// --- Render Explorer Items checklist ---
function renderProjectFiles() {
  explorerItemsContainer.innerHTML = '';
  
  if (projectFiles.length === 0) {
    explorerItemsContainer.innerHTML = `
      <div class="empty-state">
        <p>No root-level directories or files found to configure.</p>
      </div>
    `;
    return;
  }

  projectFiles.forEach(item => {
    const isExcluded = excludedPaths.has(item.name);
    
    const itemEl = document.createElement('div');
    itemEl.className = `explorer-item ${isExcluded ? 'excluded' : ''}`;
    itemEl.setAttribute('data-item-name', item.name);
    
    // Choose appropriate SVG icons
    const iconSvg = item.isDirectory
      ? `<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M10,4H4C2.89,4 2,4.89 2,6V18A2,2 0 0,0 4,20H20A2,2 0 0,0 22,18V8C22,6.89 21.1,6 20,6H12L10,4Z"/></svg>`
      : `<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M13,9V3.5L18.5,9M6,2C4.89,2 4,2.89 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2H6Z"/></svg>`;
      
    const typeLabel = item.isDirectory
      ? `<span class="explorer-badge-tag badge-folder">Folder</span>`
      : `<span class="explorer-badge-tag badge-file">File</span>`;

    itemEl.innerHTML = `
      <div class="explorer-item-left">
        <input type="checkbox" class="explorer-item-checkbox" ${isExcluded ? '' : 'checked'}>
        <span class="explorer-item-icon">${iconSvg}</span>
        <span class="explorer-item-name">${item.name}</span>
      </div>
      <div>
        ${typeLabel}
      </div>
    `;

    // Row Click toggle event
    itemEl.addEventListener('click', (e) => {
      // Check if target is the checkbox. If it is, the checkbox value is already toggled.
      const isCheckboxClick = e.target.classList.contains('explorer-item-checkbox');
      const checkbox = itemEl.querySelector('.explorer-item-checkbox');
      
      if (!isCheckboxClick) {
        checkbox.checked = !checkbox.checked;
      }
      
      toggleItemExclude(item.name, checkbox.checked);
    });

    explorerItemsContainer.appendChild(itemEl);
  });
}

// --- Toggle Exclude State for Explorer Checklist ---
function toggleItemExclude(name, isIncluded) {
  const itemEl = document.querySelector(`[data-item-name="${name}"]`);
  
  if (!isIncluded) {
    excludedPaths.add(name);
    if (itemEl) itemEl.classList.add('excluded');
  } else {
    excludedPaths.delete(name);
    if (itemEl) itemEl.classList.remove('excluded');
  }
  
  renderExclusionsSummary();
}

// --- Render Exclusion Badges Summary list ---
function renderExclusionsSummary() {
  excludesBadgesContainer.innerHTML = '';
  
  if (excludedPaths.size === 0) {
    emptyExcludesLabel.style.display = 'block';
    return;
  }

  emptyExcludesLabel.style.display = 'none';
  excludedPaths.forEach(path => {
    const badge = document.createElement('span');
    badge.className = 'exclusion-badge';
    badge.innerHTML = `
      ${path}
      <span class="badge-remove" style="cursor: pointer; font-weight: bold; margin-left: 4px;">&times;</span>
    `;

    // Clicking cross button restores check state and deletes exclusion
    badge.querySelector('.badge-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      const checkbox = document.querySelector(`[data-item-name="${path}"] .explorer-item-checkbox`);
      if (checkbox) checkbox.checked = true;
      toggleItemExclude(path, true);
    });

    excludesBadgesContainer.appendChild(badge);
  });
}

// --- Select All & Deselect All Operations ---
explorerSelectAll.addEventListener('click', () => {
  excludedPaths.clear();
  const checkboxes = document.querySelectorAll('.explorer-item-checkbox');
  checkboxes.forEach(cb => cb.checked = true);
  
  const items = document.querySelectorAll('.explorer-item');
  items.forEach(el => el.classList.remove('excluded'));
  
  renderExclusionsSummary();
  showToast('Included all project directories and files.', 'info');
});

explorerDeselectAll.addEventListener('click', () => {
  projectFiles.forEach(item => excludedPaths.add(item.name));
  const checkboxes = document.querySelectorAll('.explorer-item-checkbox');
  checkboxes.forEach(cb => cb.checked = false);
  
  const items = document.querySelectorAll('.explorer-item');
  items.forEach(el => el.classList.add('excluded'));
  
  renderExclusionsSummary();
  showToast('Excluded all project files from snapshots.', 'warning');
});

// --- Real-time Log Stream Connection ---
function initLogsStream() {
  if (sseSource) {
    sseSource.close();
  }

  sseSource = new EventSource('/api/logs/stream');

  sseSource.onmessage = function(event) {
    const data = JSON.parse(event.data);
    
    if (data.type === 'status') {
      updateTaskStatus(data);
    } else if (data.type === 'log') {
      appendConsoleLog(data.text, data.stream);
    } else if (data.type === 'done') {
      handleTaskCompleted(data.code);
    }
  };

  sseSource.onerror = function() {
    console.error('SSE Connection failed. Reconnecting...');
    miniConsoleTitle.textContent = 'Console Output: Disconnected';
    miniConsoleDot.className = 'status-dot';
  };
}

// --- Update UI to reflect Task States ---
let lastTaskType = null;

function updateTaskStatus(task) {
  activeTask = task;
  
  const sidebarDot = document.getElementById('sidebar-status-dot');
  const sidebarText = document.getElementById('sidebar-status-text');
  
  const rapidSubmitBtn = document.querySelector('#overview-rapid-form button[type="submit"]');

  if (task.status === 'running') {
    lastTaskType = task.taskType;
    
    // Disable inputs
    if (rapidSubmitBtn) {
      rapidSubmitBtn.disabled = true;
      rapidSubmitBtn.innerHTML = '<div class="spinner" style="width: 14px; height: 14px; margin: 0 8px 0 0; display: inline-block;"></div> Executing...';
    }
    explorerSubmitBtn.disabled = true;
    explorerSubmitBtn.innerHTML = '<div class="spinner" style="width: 14px; height: 14px; margin: 0 8px 0 0; display: inline-block;"></div> Executing...';
    refreshSnapshotsBtn.disabled = true;
    
    // Disable Settings & Git inputs
    if (settingsSaveBtn) {
      settingsSaveBtn.disabled = true;
      settingsSaveBtn.innerHTML = '<div class="spinner" style="width: 14px; height: 14px; margin: 0 8px 0 0; display: inline-block;"></div> Saving...';
    }
    if (gitDeployBtn) {
      gitDeployBtn.disabled = true;
      gitDeployBtn.innerHTML = '<div class="spinner" style="width: 14px; height: 14px; margin: 0 8px 0 0; display: inline-block;"></div> Deploying...';
    }
    if (gitRefreshBtn) gitRefreshBtn.disabled = true;
    if (gitCommitMessage) gitCommitMessage.disabled = true;
    
    // Update sidebar text
    sidebarDot.className = 'status-dot dot-running';
    sidebarText.textContent = `Running: ${task.taskType} (${task.project})`;
    
    // Update mini-console header status
    miniConsoleDot.className = 'status-dot dot-running';
    miniConsoleTitle.textContent = `Running: ${task.taskType} (${task.project})`;
    
    // Automatically expand the docked mini-console panel
    miniConsole.classList.add('expanded');
  } else {
    // Enable inputs
    if (rapidSubmitBtn) {
      rapidSubmitBtn.disabled = false;
      rapidSubmitBtn.textContent = 'Take Snapshot';
    }
    explorerSubmitBtn.disabled = false;
    explorerSubmitBtn.textContent = 'Take Custom Snapshot';
    refreshSnapshotsBtn.disabled = false;
    
    // Enable Settings & Git inputs
    if (settingsSaveBtn) {
      settingsSaveBtn.disabled = false;
      settingsSaveBtn.textContent = 'Save Settings';
    }
    if (gitDeployBtn) {
      gitDeployBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="18" height="18" style="margin-right: 6px;">
          <path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12S6.48 22 12 22 22 17.52 22 12 17.52 2 12 2M11 16H13V18H11V16M11 6H13V14H11V6Z"/>
        </svg>
        Push to Production
      `;
      validateGitForm();
    }
    if (gitRefreshBtn) gitRefreshBtn.disabled = false;
    if (gitCommitMessage) gitCommitMessage.disabled = false;

    // Reset status bars
    sidebarDot.className = 'status-dot dot-idle';
    sidebarText.textContent = 'System Idle';
    
    miniConsoleDot.className = 'status-dot dot-idle';
    miniConsoleTitle.textContent = 'Console Output';

    hideProgress();
  }
}

// --- Handle Task Termination event ---
function handleTaskCompleted(code) {
  if (lastTaskType === 'deploy') {
    if (code === 0) {
      setStepStatus(stepGitCommit, 'completed');
      setStepStatus(stepGitPush,   'completed');
      setStepStatus(stepGitScp,    'completed');
      setStepStatus(stepGitCicd,   'completed');
      setStepStatus(stepGitVerify, 'completed');
      showToast('Production deployment completed successfully!', 'success');
    } else {
      // Mark whichever step is currently running as failed
      const steps = [stepGitCommit, stepGitPush, stepGitScp, stepGitCicd, stepGitVerify];
      const runningStep = steps.find(s => s && s.classList.contains('step-running'));
      if (runningStep) {
        setStepStatus(runningStep, 'failed');
      } else {
        setStepStatus(stepGitVerify, 'failed');
      }
      showToast(`Deployment pipeline failed with exit code: ${code}`, 'error');
    }
    loadGitStatus();
  } else {
    if (code === 0) {
      showToast('Task completed successfully!', 'success');
    } else {
      showToast(`Task execution failed with code: ${code}`, 'error');
    }
  }
  
  // Reload snapshots panel registry data
  loadProjectSnapshots(currentProject);
}

// --- Action: Take Rapid Snapshot ---
overviewRapidForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  if (activeTask.status === 'running') {
    showToast('A backup or recovery action is currently executing.', 'warning');
    return;
  }

  const desc = rapidDescInput.value.trim();
  const live = rapidLiveCheck.checked;
  const noDb = rapidNoDbCheck.checked;

  await triggerSnapshotCreation({
    project: currentProject,
    description: desc,
    live,
    noDb,
    excludePaths: []
  });

  rapidDescInput.value = '';
});

// --- Action: Take Custom Snapshot (Folder Explorer Exclusions) ---
explorerSnapshotForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  if (activeTask.status === 'running') {
    showToast('A backup or recovery action is currently executing.', 'warning');
    return;
  }

  const desc = explorerDescInput.value.trim();
  const live = explorerLiveCheck.checked;
  const noDb = explorerNoDbCheck.checked;

  // Convert Set to array of exclusion paths
  const excludePaths = Array.from(excludedPaths);

  await triggerSnapshotCreation({
    project: currentProject,
    description: desc,
    live,
    noDb,
    excludePaths
  });

  explorerDescInput.value = '';
});

// --- Action: Save Settings & SSH Credentials ---
if (settingsForm) {
  settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    if (activeTask.status === 'running') {
      showToast('Cannot save settings during active operations.', 'warning');
      return;
    }
    
    const payload = {
      project: currentProject,
      sshHost: settingsSshHost.value.trim(),
      sshUser: settingsSshUser.value.trim(),
      sshPassword: settingsSshPassword.value,
      sshHostKey: settingsSshHostkey.value.trim(),
      gitRepo: settingsGitRepo.value.trim(),
      gitBranch: settingsGitBranch.value.trim(),
      siteUrl: settingsSiteUrl.value.trim(),
      vpsInstallRoot: settingsVpsRoot.value.trim()
    };
    
    settingsSaveBtn.disabled = true;
    settingsSaveBtn.innerHTML = '<div class="spinner" style="width: 14px; height: 14px; margin: 0 8px 0 0; display: inline-block;"></div> Saving...';
    
    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      if (response.ok) {
        showToast('Settings & SSH credentials saved successfully!', 'success');
        loadProjects();
      } else {
        const err = await response.json();
        showToast(`Failed to save settings: ${err.error}`, 'error');
      }
    } catch (err) {
      showToast('Failed to contact server for settings update.', 'error');
    } finally {
      settingsSaveBtn.disabled = false;
      settingsSaveBtn.textContent = 'Save Settings';
    }
  });
}

// --- Validate Git Deployment Form ---
function validateGitForm() {
  if (activeTask.status === 'running') return;
  const commitMsg = gitCommitMessage ? gitCommitMessage.value.trim() : '';
  const needsOverwrite = gitOverwriteDb ? gitOverwriteDb.checked : false;
  const isConfirmed = gitDbConfirmInput ? gitDbConfirmInput.value.trim().toUpperCase() === 'OVERWRITE' : false;

  const gitSelect = document.getElementById('git-snapshot-select');
  const snapshotSelected = gitSelect ? gitSelect.value : '';

  const isDisabled = !commitMsg || !snapshotSelected || (needsOverwrite && !isConfirmed);
  if (gitDeployBtn) {
    gitDeployBtn.disabled = isDisabled;
  }
}

// --- Action: Trigger Git Deployment ---
if (gitDeployForm) {
  gitDeployForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (activeTask.status === 'running') {
      showToast('A deployment or backup task is currently executing.', 'warning');
      return;
    }

    const commitMessage = gitCommitMessage.value.trim();
    if (!commitMessage) {
      showToast('A commit message is required to deploy.', 'warning');
      return;
    }

    const overwriteDb = gitOverwriteDb ? gitOverwriteDb.checked : false;
    if (overwriteDb && (!gitDbConfirmInput || gitDbConfirmInput.value.trim().toUpperCase() !== 'OVERWRITE')) {
      showToast('Please type OVERWRITE to confirm database replacement.', 'warning');
      return;
    }

    const gitSelect = document.getElementById('git-snapshot-select');
    const snapshotName = gitSelect ? gitSelect.value : '';

    if (!snapshotName) {
      showToast('A recovery snapshot must be selected to initiate deployment.', 'warning');
      return;
    }

    // Show and reset stepper
    if (gitStepper) gitStepper.style.display = 'block';
    resetStepper();

    try {
      const response = await fetch('/api/git/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commitMessage, overwriteDb, snapshotName, project: currentProject })
      });

      if (response.ok) {
        showToast('Git deployment pipeline initiated. Monitoring progress...', 'success');
        gitCommitMessage.value = '';
        if (gitOverwriteDb) gitOverwriteDb.checked = false;
        if (gitDbConfirmGroup) gitDbConfirmGroup.style.display = 'none';
        if (gitDbConfirmInput) gitDbConfirmInput.value = '';
        validateGitForm();
      } else {
        const err = await response.json();
        showToast(`Deployment failed: ${err.error}`, 'error');
        setStepStatus(stepGitCommit, 'failed');
      }
    } catch (err) {
      showToast('Failed to contact server to trigger deployment.', 'error');
      setStepStatus(stepGitCommit, 'failed');
    }
  });
}

// Git Deployment form input validation listeners
if (gitOverwriteDb) {
  gitOverwriteDb.addEventListener('change', (e) => {
    if (e.target.checked) {
      if (gitDbConfirmGroup) {
        gitDbConfirmGroup.style.display = 'block';
      }
      if (gitDbConfirmInput) {
        gitDbConfirmInput.value = '';
        gitDbConfirmInput.focus();
      }
    } else {
      if (gitDbConfirmGroup) {
        gitDbConfirmGroup.style.display = 'none';
      }
    }
    validateGitForm();
  });
}

if (gitDbConfirmInput) {
  gitDbConfirmInput.addEventListener('input', validateGitForm);
}

if (gitCommitMessage) {
  gitCommitMessage.addEventListener('input', validateGitForm);
}

// --- Submit Snapshot Creation to API ---
async function triggerSnapshotCreation(payload) {
  try {
    const response = await fetch('/api/snapshots/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      showToast('Snapshot task queued. Streaming log outputs...', 'success');
    } else {
      const err = await response.json();
      showToast(`Creation failed: ${err.error}`, 'error');
    }
  } catch (err) {
    showToast('Failed to contact Snapshot Panel backend.', 'error');
  }
}

// --- Restore Modal Confirmation Controller ---
function triggerRestoreConfirm(snapshot) {
  if (activeTask.status === 'running') {
    showToast('A recovery process is already executing.', 'warning');
    return;
  }

  activeRestoreSnapshot = snapshot;
  modalRestoreProject.textContent = currentProject;
  modalRestoreId.textContent = snapshot.name;
  modalRestoreDesc.textContent = snapshot.description;
  modalRestoreTime.textContent = getAbsoluteTime(snapshot.timestamp);
  
  restoreConfirmInput.value = '';
  confirmRestoreBtn.disabled = true;
  modalRestoreSkipBackup.checked = false;

  restoreModal.classList.add('active');
  restoreConfirmInput.focus();
}

restoreConfirmInput.addEventListener('input', (e) => {
  confirmRestoreBtn.disabled = e.target.value.trim().toUpperCase() !== 'RESTORE';
});

cancelRestoreBtn.addEventListener('click', () => {
  restoreModal.classList.remove('active');
  activeRestoreSnapshot = null;
});

confirmRestoreBtn.addEventListener('click', async () => {
  if (!activeRestoreSnapshot) return;
  restoreModal.classList.remove('active');

  const skipPreBackup = modalRestoreSkipBackup.checked;

  try {
    const response = await fetch('/api/snapshots/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: currentProject,
        snapshotName: activeRestoreSnapshot.name,
        skipPreBackup
      })
    });

    if (response.ok) {
      showToast('Snapshot restoration initiated. Streaming logs...', 'success');
    } else {
      const err = await response.json();
      showToast(`Restore execution failed: ${err.error}`, 'error');
    }
  } catch (err) {
    showToast('Failed to contact Snapshot Panel backend.', 'error');
  }
});

// --- Delete Modal Confirmation Controller ---
function triggerDeleteConfirm(snapshot) {
  if (activeTask.status === 'running') {
    showToast('Cannot delete snapshots during active operations.', 'warning');
    return;
  }

  activeDeleteSnapshot = snapshot;
  modalDeleteId.textContent = snapshot.name;
  modalDeleteDesc.textContent = snapshot.description;

  deleteModal.classList.add('active');
}

cancelDeleteBtn.addEventListener('click', () => {
  deleteModal.classList.remove('active');
  activeDeleteSnapshot = null;
});

confirmDeleteBtn.addEventListener('click', async () => {
  if (!activeDeleteSnapshot) return;
  deleteModal.classList.remove('active');

  try {
    const response = await fetch(`/api/snapshots?project=${currentProject}&name=${activeDeleteSnapshot.name}`, {
      method: 'DELETE'
    });

    if (response.ok) {
      showToast('Snapshot deleted from registry.', 'success');
      loadProjectSnapshots(currentProject);
    } else {
      const err = await response.json();
      showToast(`Snapshot deletion failed: ${err.error}`, 'error');
    }
  } catch (err) {
    showToast('Failed to contact Snapshot Panel backend.', 'error');
  }
});

// --- UI Interaction Event Binding ---

// Project selector change listener
projectSelect.addEventListener('change', async (e) => {
  currentProject = e.target.value;
  await loadProjectSnapshots(currentProject);
  await loadProjectFiles(currentProject);
});

// Snapshots manual sync list click
refreshSnapshotsBtn.addEventListener('click', () => {
  loadProjectSnapshots(currentProject);
});

// Console header click - expands / collapses mini-console
miniConsoleHeader.addEventListener('click', (e) => {
  // Ignore clicks on expand SVGs and let the toggle handle it
  miniConsole.classList.toggle('expanded');
});

// Clear console buffer triggers
terminalClearBtn.addEventListener('click', () => {
  terminalOutputPre.textContent = 'Console is ready. Executed actions will stream output logs here...';
});

// Container Status Badge Helper
function getContainerBadge(status) {
  if (status === 'running') return '<span class="badge badge-success">Running</span>';
  if (status === 'stopped') return '<span class="badge badge-danger">Stopped</span>';
  return '<span class="badge badge-muted">Missing</span>';
}

// Health & Parity Run Audit Click Listener
if (runParityBtn) {
  runParityBtn.addEventListener('click', async () => {
    // Show spinner and progress states
    if (parityEmpty) parityEmpty.style.display = 'none';
    if (parityResults) parityResults.style.display = 'none';
    if (parityMetrics) parityMetrics.style.display = 'none';
    if (parityLoading) parityLoading.style.display = 'flex';
    
    runParityBtn.disabled = true;
    runParityBtn.innerHTML = '<div class="spinner" style="width: 14px; height: 14px; margin: 0 8px 0 0; display: inline-block;"></div> Auditing...';
    
    try {
      const response = await fetch(`/api/parity/check?project=${currentProject}`);
      if (!response.ok) throw new Error('Parity API returned error code ' + response.status);
      const data = await response.json();
      
      // 1. Overall metrics card values
      if (valGitSync) {
        if (data.git.parity) {
          valGitSync.textContent = 'In Sync';
          valGitSync.className = 'metric-value text-success';
        } else {
          valGitSync.textContent = 'Out of Sync';
          valGitSync.className = 'metric-value text-danger';
        }
      }
      
      if (valSiteStatus) {
        const homeEp = data.endpoints.find(e => e.path === '/');
        const isOnline = homeEp && homeEp.prodStatus === 200;
        if (isOnline) {
          valSiteStatus.textContent = 'Online';
          valSiteStatus.className = 'metric-value text-success';
        } else {
          valSiteStatus.textContent = 'Offline';
          valSiteStatus.className = 'metric-value text-danger';
        }
      }
      
      if (valSslStatus) {
        if (data.security.ssl && data.security.ssl.valid) {
          valSslStatus.textContent = `${data.security.ssl.daysRemaining} Days`;
          if (data.security.ssl.daysRemaining > 30) {
            valSslStatus.className = 'metric-value text-success';
          } else if (data.security.ssl.daysRemaining > 7) {
            valSslStatus.className = 'metric-value text-warning';
          } else {
            valSslStatus.className = 'metric-value text-danger';
          }
        } else {
          valSslStatus.textContent = 'Expired/Error';
          valSslStatus.className = 'metric-value text-danger';
        }
      }
      
      if (valSecurityStatus) {
        const portLeak = data.security.portLeakDetected;
        const dbErr = data.security.dbErrorDetected;
        if (!portLeak && !dbErr) {
          valSecurityStatus.textContent = 'Secure';
          valSecurityStatus.className = 'metric-value text-success';
        } else {
          let issues = [];
          if (portLeak) issues.push('Port Leak');
          if (dbErr) issues.push('DB Error');
          valSecurityStatus.textContent = issues.join(' & ');
          valSecurityStatus.className = 'metric-value text-danger';
        }
      }
      
      // 2. Services & Containers Parity table
      if (parityContainersTbody) {
        const servicesList = [
          { key: 'mysql', name: 'MySQL Database' },
          { key: 'redis', name: 'Redis Cache' },
          { key: 'php', name: 'PHP-FPM Engine' },
          { key: 'nginx', name: 'Nginx Web Server' }
        ];

        parityContainersTbody.innerHTML = '';
        servicesList.forEach(svc => {
          const localStatus = (data.containers.local && data.containers.local[svc.key]) || 'missing';
          const vpsStatus = (data.containers.vps && data.containers.vps[svc.key]) || 'missing';
          
          const localBadge = getContainerBadge(localStatus);
          const vpsBadge = getContainerBadge(vpsStatus);
          
          const parityBadge = localStatus === vpsStatus && localStatus !== 'missing'
            ? '<span class="badge badge-teal">In Sync</span>'
            : '<span class="badge badge-danger">Mismatch</span>';
            
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td><strong>${svc.name}</strong></td>
            <td>${localBadge}</td>
            <td>${vpsBadge}</td>
            <td>${parityBadge}</td>
          `;
          parityContainersTbody.appendChild(tr);
        });
      }
      
      // 3. Endpoint Health Validation table
      if (parityEndpointsTbody) {
        parityEndpointsTbody.innerHTML = '';
        data.endpoints.forEach(ep => {
          const localStatusText = ep.localStatus === 200 
            ? '<span class="text-success font-bold">200 OK</span>' 
            : `<span class="text-danger font-bold">${ep.localStatus || 'Offline'}</span>`;
            
          const localLatencyText = ep.localStatus > 0 ? `${ep.localTime}ms` : '-';
          
          const prodStatusText = ep.prodStatus === 200 
            ? '<span class="text-success font-bold">200 OK</span>' 
            : `<span class="text-danger font-bold">${ep.prodStatus || 'Offline'}</span>`;
            
          const prodLatencyText = ep.prodStatus > 0 ? `${ep.prodTime}ms` : '-';
          
          const titleBadge = ep.titleParity
            ? `<span class="badge badge-teal" title="Title: ${ep.prodTitle}">Match</span>`
            : `<span class="badge badge-danger" title="Local: ${ep.localTitle || 'None'} vs Prod: ${ep.prodTitle || 'None'}">Mismatch</span>`;
            
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td>
              <div style="font-weight: 600; color: #fff;">${ep.name}</div>
              <code style="font-size: 11px; color: var(--text-desc);">${ep.path}</code>
            </td>
            <td>${localStatusText}</td>
            <td>${localLatencyText}</td>
            <td>${prodStatusText}</td>
            <td>${prodLatencyText}</td>
            <td>${titleBadge}</td>
          `;
          parityEndpointsTbody.appendChild(tr);
        });
      }
      
      // 4. Security & Port Audits deep diagnostics
      if (diagPortLeak) {
        diagPortLeak.innerHTML = data.security.portLeakDetected 
          ? '<span class="text-danger font-bold">PORT LEAK (:9080/:9082) FOUND</span>' 
          : '<span class="text-success font-bold">SECURE (No Port Leaks)</span>';
      }
      if (diagDbHealth) {
        diagDbHealth.innerHTML = data.security.dbErrorDetected 
          ? '<span class="text-danger font-bold">DATABASE CONNECTION ERROR DETECTED</span>' 
          : '<span class="text-success font-bold">OK (No Database Errors)</span>';
      }
      
      if (data.security.ssl && data.security.ssl.valid) {
        if (diagSslDomain) diagSslDomain.textContent = data.security.ssl.subject || 'mypools.co.za';
        if (diagSslIssuer) diagSslIssuer.textContent = data.security.ssl.issuer || 'N/A';
        if (diagSslExpiry) diagSslExpiry.textContent = getAbsoluteTime(data.security.ssl.expiry);
      } else {
        const errText = data.security.ssl ? (data.security.ssl.error || 'N/A') : 'N/A';
        if (diagSslDomain) diagSslDomain.textContent = 'N/A';
        if (diagSslIssuer) diagSslIssuer.textContent = 'N/A';
        if (diagSslExpiry) diagSslExpiry.innerHTML = `<span class="text-danger">${errText}</span>`;
      }
      
      // 5. VPS Host Diagnostics
      if (diagSysDisk) diagSysDisk.textContent = data.system.diskUsage || 'unknown';
      if (diagSysRam) diagSysRam.textContent = data.system.memoryUsage || 'unknown';
      if (diagSysCpu) diagSysCpu.textContent = data.system.cpuLoad || 'unknown';

      if (diagGitLocalCommit) {
        const hash = data.git.localCommit || 'unknown';
        diagGitLocalCommit.innerHTML = hash !== 'unknown' 
          ? `<span class="git-code">${hash.substring(0, 8)}</span>` 
          : '<span class="text-muted">unknown</span>';
      }
      if (diagGitVpsCommit) {
        const hash = data.git.vpsCommit || 'unknown';
        diagGitVpsCommit.innerHTML = hash !== 'unknown' 
          ? `<span class="git-code">${hash.substring(0, 8)}</span>` 
          : '<span class="text-muted">unknown</span>';
      }
      
      // Render layout visibility
      if (parityLoading) parityLoading.style.display = 'none';
      if (parityMetrics) parityMetrics.style.display = 'grid';
      if (parityResults) parityResults.style.display = 'flex';
      
      showToast('Parity audit completed successfully!', 'success');
    } catch (err) {
      if (parityLoading) parityLoading.style.display = 'none';
      if (parityEmpty) parityEmpty.style.display = 'flex';
      showToast('Parity check failed: ' + err.message, 'error');
    } finally {
      runParityBtn.disabled = false;
      runParityBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="18" height="18" style="margin-right: 6px;">
          <path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12S6.48 22 12 22 22 17.52 22 12 17.52 2 12 2M10 17L5 12L6.41 10.59L10 14.17L17.59 6.58L19 8L10 17Z"/>
        </svg>
        Run Verification Audit
      `;
    }
  });
}

// --- Project Management Action Bindings ---
if (addProjectBtn) {
  addProjectBtn.addEventListener('click', () => {
    if (newProjectPath) newProjectPath.value = '';
    if (newProjectName) newProjectName.value = '';
    if (addProjectModal) addProjectModal.classList.add('active');
  });
}

if (cancelAddProjectBtn) {
  cancelAddProjectBtn.addEventListener('click', () => {
    if (addProjectModal) addProjectModal.classList.remove('active');
  });
}

if (confirmAddProjectBtn) {
  confirmAddProjectBtn.addEventListener('click', async () => {
    const pathVal = newProjectPath ? newProjectPath.value.trim() : '';
    const nameVal = newProjectName ? newProjectName.value.trim() : '';
    if (!pathVal) {
      showToast('Project folder path is required.', 'warning');
      return;
    }
    
    confirmAddProjectBtn.disabled = true;
    confirmAddProjectBtn.innerHTML = '<div class="spinner" style="width: 14px; height: 14px; margin: 0 8px 0 0; display: inline-block;"></div> Adding...';
    
    try {
      const response = await fetch('/api/projects/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: pathVal, name: nameVal })
      });
      
      if (response.ok) {
        showToast('Project mapping added successfully!', 'success');
        if (addProjectModal) addProjectModal.classList.remove('active');
        
        // Auto-select newly added project
        if (nameVal) {
          currentProject = nameVal;
        } else {
          const pathParts = pathVal.replace(/\\/g, '/').split('/');
          const nameCandidate = pathParts.pop() || pathParts.pop();
          if (nameCandidate) {
            currentProject = nameCandidate;
          }
        }
        
        await loadProjects();
      } else {
        const err = await response.json();
        showToast(`Failed to add project: ${err.error}`, 'error');
      }
    } catch (err) {
      showToast('Failed to contact server to add project.', 'error');
    } finally {
      confirmAddProjectBtn.disabled = false;
      confirmAddProjectBtn.textContent = 'Add Project';
    }
  });
}

if (newProjectPath) {
  newProjectPath.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (confirmAddProjectBtn) confirmAddProjectBtn.click();
    }
  });
}

if (newProjectName) {
  newProjectName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (confirmAddProjectBtn) confirmAddProjectBtn.click();
    }
  });
}

if (deleteProjectBtn) {
  deleteProjectBtn.addEventListener('click', async () => {
    if (!currentProject) {
      showToast('No project selected to remove.', 'warning');
      return;
    }
    
    let confirmMsg = `Are you sure you want to remove project "${currentProject}" from the console?\nThis will not delete the project files or snapshots on disk, just the mapping in this dashboard.`;
    if (currentProject.toLowerCase() === 'mypools') {
      confirmMsg = `WARNING: You are removing the default "mypools" project mapping.\n\n${confirmMsg}`;
    }
    
    const confirmRemove = confirm(confirmMsg);
    if (!confirmRemove) return;
    
    deleteProjectBtn.disabled = true;
    
    try {
      const response = await fetch(`/api/projects?project=${currentProject}`, {
        method: 'DELETE'
      });
      
      if (response.ok) {
        showToast(`Project "${currentProject}" removed successfully.`, 'success');
        currentProject = '';
        await loadProjects();
      } else {
        const err = await response.json();
        showToast(`Failed to remove project: ${err.error}`, 'error');
      }
    } catch (err) {
      showToast('Failed to contact server to remove project.', 'error');
    } finally {
      deleteProjectBtn.disabled = false;
    }
  });
}

const gitSnapshotSelect = document.getElementById('git-snapshot-select');
if (gitSnapshotSelect) {
  gitSnapshotSelect.addEventListener('change', validateGitForm);
}

// Folder browser implementation
async function browseFolder(targetInputEl) {
  try {
    const response = await fetch('/api/fs/browse');
    if (response.ok) {
      const data = await response.json();
      if (data.path) {
        targetInputEl.value = data.path;
        targetInputEl.dispatchEvent(new Event('change', { bubbles: true }));
        targetInputEl.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else {
      showToast('Server failed to open directory selector.', 'error');
    }
  } catch (err) {
    showToast('Failed to contact server for directory browse.', 'error');
  }
}

// --- Application Entry Point Initialize ---
document.addEventListener('DOMContentLoaded', () => {
  loadProjects();
  loadSettings();
  initLogsStream();
  validateGitForm();

  // Bind Browse buttons
  const browseProjectPathBtn = document.getElementById('browse-project-path-btn');
  if (browseProjectPathBtn && newProjectPath) {
    browseProjectPathBtn.addEventListener('click', () => browseFolder(newProjectPath));
  }

  const browseSettingsGitRepoBtn = document.getElementById('browse-settings-git-repo-btn');
  if (browseSettingsGitRepoBtn && settingsGitRepo) {
    browseSettingsGitRepoBtn.addEventListener('click', () => browseFolder(settingsGitRepo));
  }
});
