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
const settingsRetentionCount = document.getElementById('settings-retention-count');
const settingsSaveBtn = document.getElementById('settings-save-btn');

// Git Deployment Tab DOM Elements
const gitRefreshBtn = document.getElementById('git-refresh-btn');
const gitBranchVal = document.getElementById('git-branch-val');
// Wire git refresh button
if (gitRefreshBtn) {
  gitRefreshBtn.addEventListener('click', () => {
    loadGitStatus();
    loadVersionParity();
    showToast('Refreshing git status...', 'info');
  });
}
const gitModifiedCount = document.getElementById('git-modified-count');
const gitUntrackedCount = document.getElementById('git-untracked-count');
const gitFilesContainer = document.getElementById('git-files-container');
const gitDeployForm = document.getElementById('git-deploy-form');
const gitCommitMessage = document.getElementById('git-commit-message');
const gitDeployBtn = document.getElementById('git-deploy-btn');
const gitIncludeDb = document.getElementById('git-include-db');
const gitDbWarning = document.getElementById('git-db-warning');
const gitDbConfirm = document.getElementById('git-db-confirm');
const gitStepper = document.getElementById('git-stepper');
const gitDeployProgressPct = document.getElementById('git-deploy-progress-pct');
const gitDeployProgressFill = document.getElementById('git-deploy-progress-fill');
const gitDeployStatusText = document.getElementById('git-deploy-status-text');
const gitCicdStatusBanner = document.getElementById('git-cicd-status-banner');
const gitCicdStatusText = document.getElementById('git-cicd-status-text');
// File progress bar elements
const gitFileProgressContainer = document.getElementById('git-file-progress-container');
const gitFileProgressText = document.getElementById('git-file-progress-text');
const gitFileProgressBar = document.getElementById('git-file-progress-bar');
// Version parity elements
const gitVersionsRefreshBtn = document.getElementById('git-versions-refresh-btn');
const gitParityIndicator = document.getElementById('git-parity-indicator');
const gitParityText = document.getElementById('git-parity-text');
const gitVersionLocal = document.getElementById('git-version-local');
const gitVersionRemote = document.getElementById('git-version-remote');
const gitVersionServer = document.getElementById('git-version-server');
const gitVersionLocalIcon = document.getElementById('git-version-local-icon');
const gitVersionRemoteIcon = document.getElementById('git-version-remote-icon');
const gitVersionServerIcon = document.getElementById('git-version-server-icon');

// Stepper Step Elements (5-step git deployment pipeline)
const stepGitCommit = document.getElementById('step-git-commit');
const stepGitPush   = document.getElementById('step-git-push');
const stepGitVps    = document.getElementById('step-git-vps');
const stepGitCicd   = document.getElementById('step-git-cicd');
const stepGitVerify = document.getElementById('step-git-verify');

let gitParityInterval = null;

// Overview Tab Metrics (Moved to Health & Parity)
const overviewDir = document.getElementById('overview-dir');
const overviewCount = document.getElementById('overview-count');
const overviewLatest = document.getElementById('overview-latest');
const overviewComposeName = document.getElementById('overview-compose-name');

// Snapshots Tab
const snapshotsGridBody = document.getElementById('snapshots-grid-body');
const refreshSnapshotsBtn = document.getElementById('refresh-snapshots-btn');

// Explorer Tab
const explorerSnapshotForm = document.getElementById('explorer-snapshot-form');
const explorerDescInput = document.getElementById('explorer-desc');
const explorerLiveCheck = document.getElementById('explorer-live');
const explorerLevelSelect = document.getElementById('explorer-level');
const explorerExcludePaths = document.getElementById('explorer-exclude-paths');
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
  const isDeployTask = activeTask.type === 'deploy' || lastTaskType === 'deploy';

  // Check for progress match e.g. [PROGRESS] 45% (message...)
  const progressMatch = text.match(/\[PROGRESS\]\s+(\d+)%(?:\s*\(([^)]*)\))?/i);
  if (progressMatch) {
    const pct = parseInt(progressMatch[1], 10);
    if (isDeployTask) {
      updateStepperFromLog(text);
      if (progressMatch[2] && gitDeployStatusText) {
        gitDeployStatusText.textContent = progressMatch[2];
      }
    }
    updateProgress(pct);
    return;
  }

  // Update stepper if active task is deployment
  if (isDeployTask) {
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

  const gitDeployProgressCard = document.getElementById('git-deploy-progress-card');

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

  // Git Deployment tab — always-visible pipeline progress
  if (gitDeployProgressPct) gitDeployProgressPct.textContent = `${pct}%`;
  if (gitDeployProgressFill) gitDeployProgressFill.style.width = `${pct}%`;
  if (gitDeployProgressCard) gitDeployProgressCard.classList.add('is-active');
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

    // Manage polling and fetch tab-specific data
    if (targetTab === 'dashboard') {
      startLocalHealthPolling();
      loadServerStatus();
    } else if (targetTab === 'parity') {
      startStatsPolling();
      checkLocalPorts();
      startLocalHealthPolling();
    } else {
      stopStatsPolling();
      stopLocalHealthPolling();
    }

    if (targetTab === 'settings') {
      loadSettings();
    } else if (targetTab === 'git') {
      loadGitStatus();
      loadVersionParity();
    }
  });
});

// --- Health & Parity Sub-Tab Navigation ---
document.querySelectorAll('.sub-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const targetSubTab = btn.getAttribute('data-sub-tab');
    
    document.querySelectorAll('.sub-tab-btn').forEach(b => {
      b.classList.remove('active');
      b.style.background = 'none';
      b.style.borderColor = 'transparent';
      b.style.color = 'var(--text-desc)';
    });
    
    btn.classList.add('active');
    btn.style.background = 'rgba(255, 255, 255, 0.05)';
    btn.style.borderColor = 'var(--border-subtle)';
    btn.style.color = '#fff';
    
    document.querySelectorAll('.parity-sub-panel').forEach(panel => {
      if (panel.id === `sub-panel-${targetSubTab}`) {
        panel.style.display = 'block';
      } else {
        panel.style.display = 'none';
      }
    });
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
      await loadSettings();
      await loadGitStatus();
      loadVersionParity();
      checkLocalPorts();
      const activeTabItem = document.querySelector('.nav-item.active');
      const activeTab = activeTabItem ? activeTabItem.getAttribute('data-tab') : '';
      if (activeTab === 'parity' || activeTab === 'dashboard') {
        startLocalHealthPolling();
        if (activeTab === 'parity') {
          startStatsPolling();
        }
      }
    } else {
      currentProject = '';
      if (overviewDir) overviewDir.textContent = 'None';
      if (overviewComposeName) overviewComposeName.textContent = '-';
      if (overviewCount) overviewCount.textContent = '0';
      if (overviewLatest) overviewLatest.textContent = 'Never';
      renderEmptyState();
    }
  } catch (err) {
    showToast('Failed to load environment projects list.', 'error');
  }
}

// --- Fetch API: Load Snapshots for Project ---
async function loadProjectSnapshots(project) {
  snapshotsGridBody.innerHTML = `
    <div class="loading-state" style="padding: 40px; display: flex; align-items: center; justify-content: center; gap: 12px; width: 100%;">
      <div class="spinner"></div>
      <span>Loading snapshots registry...</span>
    </div>
  `;

  try {
    const response = await fetch(`/api/snapshots?project=${project}`);
    if (!response.ok) throw new Error('API Error');
    const data = await response.json();
    
    // Update active project info panels
    if (overviewDir) overviewDir.textContent = data.source_path || 'C:\\Podman\\' + project;
    if (overviewComposeName) overviewComposeName.textContent = project + '-local';
    if (overviewCount) overviewCount.textContent = (data.snapshots || []).length;

    const activePathEl = document.getElementById('snapshot-active-path');
    if (activePathEl) {
      activePathEl.textContent = (data.source_path || ('C:\\Podman\\' + project)) + '\\Snapshots';
    }
    
    snapshots = data.snapshots || [];
    if (snapshots.length > 0) {
      if (overviewLatest) overviewLatest.textContent = getRelativeTime(snapshots[0].timestamp);
      renderSnapshotsTable();
    } else {
      if (overviewLatest) overviewLatest.textContent = 'Never';
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
    console.error('[loadProjectSnapshots] Error:', err);
    showToast('Failed to fetch snapshots registry.', 'error');
    renderErrorState();
  }
}

// --- Render Snapshots Table Registry ---
function renderSnapshotsTable() {
  snapshotsGridBody.innerHTML = '';
  snapshots.forEach((snap, idx) => {
    const card = document.createElement('div');
    card.className = 'snapshot-card';
    if (idx === 0) {
      card.className += ' latest';
    }

    const levelVal = snap.backup_level || 'High';
    let levelBadge = '';
    if (levelVal === 'High') {
      levelBadge = '<span class="badge badge-success">High (Complete)</span>';
    } else if (levelVal === 'Medium') {
      levelBadge = '<span class="badge badge-teal">Medium (Code+DB)</span>';
    } else {
      levelBadge = '<span class="badge badge-info">Low (Framework Rollback)</span>';
    }

    const typeBadge = snap.powered_off
      ? '<span class="badge badge-success">Consistent</span>'
      : '<span class="badge badge-warning">Live</span>';

    const isLowFrameworkDb = snap.low_selective_db === true;
    const dbBadge = snap.database_included
      ? (isLowFrameworkDb 
          ? '<span class="badge badge-info">Framework DB</span>' 
          : '<span class="badge badge-teal">Database Included</span>')
      : '<span class="badge badge-muted">No DB</span>';

    const filesBadge = snap.files_included
      ? `<span class="badge badge-teal" title="${snap.files_count} files">Files Included</span>`
      : '<span class="badge badge-muted">No Files</span>';

    const gitCommit = snap.git_commit && snap.git_commit !== 'unknown'
      ? `
        <div class="snapshot-card-git-info">
          <svg class="git-icon" viewBox="0 0 24 24" width="14" height="14" style="margin-right: 4px; display: inline-block; vertical-align: middle;">
            <path fill="currentColor" d="M12,2A10,10,0,0,0,2,12C2,16.42 4.87,20.17 8.84,21.5C9.34,21.58 9.5,21.27 9.5,21C9.5,20.77 9.5,20.14 9.5,19.31C6.73,19.91 6.14,17.97 6.14,17.97C5.68,16.81 5.03,16.5 5.03,16.5C4.12,15.88 5.1,15.9 5.1,15.9C6.1,15.97 6.63,16.93 6.63,16.93C7.5,18.45 8.97,18 9.54,17.76C9.63,17.11 9.89,16.67 10.17,16.42C7.95,16.17 5.62,15.31 5.62,11.5C5.62,10.39 6,9.5 6.65,8.79C6.55,8.54 6.2,7.5 6.75,6.15C6.75,6.15 7.59,5.88 9.5,7.17C10.29,6.95 11.15,6.84 12,6.84C12.85,6.84 13.71,6.95 14.5,7.17C16.41,5.88 17.25,6.15 17.25,6.15C17.8,7.5 17.45,8.54 17.35,8.79C18,9.5 18.38,10.39 18.38,11.5C18.38,15.32 16.04,16.16 13.81,16.41C14.17,16.72 14.5,17.33 14.5,18.26C14.5,19.6 14.5,20.68 14.5,21C14.5,21.27 14.66,21.59 15.17,21.5C19.14,20.16 22,16.42 22,12A10,10,0,0,0,12,2Z"/>
          </svg>
          <span class="git-branch" style="vertical-align: middle;">${snap.git_branch}</span>
          <span class="git-separator" style="margin: 0 4px; vertical-align: middle;">@</span>
          <code class="git-hash" style="font-family: var(--font-family-mono); color: var(--color-teal); vertical-align: middle;">${snap.git_commit.substring(0, 7)}</code>
        </div>
      `
      : '';

    card.innerHTML = `
      <div class="snapshot-card-header">
        <div class="snapshot-card-time-group">
          <span class="time-relative">${getRelativeTime(snap.timestamp)}</span>
          <span class="time-absolute">${getAbsoluteTime(snap.timestamp)}</span>
        </div>
        <div class="snapshot-card-badges">
          ${levelBadge}
          ${typeBadge}
          ${dbBadge}
          ${filesBadge}
        </div>
      </div>
      <div class="snapshot-card-body">
        <div class="snapshot-card-folder-row">
          <svg class="folder-icon" viewBox="0 0 24 24" width="16" height="16" style="vertical-align: middle;">
            <path fill="currentColor" d="M10,4H4C2.89,4 2,4.89 2,6V18A2,2 0 0,0 4,20H20A2,2 0 0,0 22,18V8C22,6.89 21.1,6 20,6H12L10,4Z"/>
          </svg>
          <code class="folder-name" style="vertical-align: middle;">${snap.name}</code>
        </div>
        <h4 class="snapshot-card-desc">${snap.description}</h4>
        ${gitCommit}
      </div>
      <div class="snapshot-card-actions">
        <button class="btn btn-success btn-restore restore-btn-trigger">
          <svg viewBox="0 0 24 24" width="16" height="16" style="margin-right: 6px; display: inline-block; vertical-align: middle;">
            <path fill="currentColor" d="M12,5V1L7,6L12,11V7A6,6 0 0,1 18,13A6,6 0 0,1 12,19A6,6 0 0,1 6,13H4A8,8 0 0,0 12,21A8,8 0 0,0 20,13A8,8 0 0,0 12,5Z"/>
          </svg>
          <span style="vertical-align: middle;">Restore to this Snapshot</span>
        </button>
        <button class="btn btn-outline-danger btn-delete delete-btn-trigger" title="Delete Snapshot">
          <svg viewBox="0 0 24 24" width="16" height="16" style="display: inline-block; vertical-align: middle;">
            <path fill="currentColor" d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/>
          </svg>
          <span style="vertical-align: middle;">Delete</span>
        </button>
      </div>
    `;

    // Bind event handlers for action buttons
    card.querySelector('.restore-btn-trigger').addEventListener('click', () => triggerRestoreConfirm(snap));
    card.querySelector('.delete-btn-trigger').addEventListener('click', () => triggerDeleteConfirm(snap));
    snapshotsGridBody.appendChild(card);
  });
}

function renderEmptyState() {
  snapshotsGridBody.innerHTML = `
    <div class="empty-state-card flex-center" style="padding: 60px 20px; text-align: center; flex-direction: column; gap: 16px; width: 100%;">
      <div style="background: rgba(30, 41, 59, 0.5); padding: 16px; border-radius: 50%; border: 1px solid var(--border-subtle); display: inline-flex; align-items: center; justify-content: center; color: var(--text-muted); margin-bottom: 8px;">
        <svg viewBox="0 0 24 24" width="36" height="36">
          <path fill="currentColor" d="M12,4A4,4 0 0,1 16,8A4,4 0 0,1 12,12A4,4 0 0,1 8,8A4,4 0 0,1 12,4M12,14C16.42,14 20,15.79 20,18V20H4V18C4,15.79 7.58,14 12,14Z"/>
        </svg>
      </div>
      <div>
        <h4 style="font-family: 'Outfit', sans-serif; font-size: 16px; font-weight: 600; color: #fff; margin-bottom: 6px;">No Snapshots Found</h4>
        <p class="card-subtitle" style="margin: 0; max-width: 480px;">No recovery snapshots found for project <strong>${currentProject}</strong>.</p>
        <p class="card-subtitle" style="font-size: 12px; margin-top: 4px;">Use the sidebar or rapid snapshot panel to create one.</p>
      </div>
    </div>
  `;
}

function renderErrorState() {
  snapshotsGridBody.innerHTML = `
    <div class="empty-state-card flex-center" style="padding: 60px 20px; text-align: center; flex-direction: column; gap: 16px; width: 100%;">
      <div style="background: rgba(239, 68, 68, 0.1); padding: 16px; border-radius: 50%; border: 1px solid rgba(239, 68, 68, 0.2); display: inline-flex; align-items: center; justify-content: center; color: var(--color-danger); margin-bottom: 8px;">
        <svg viewBox="0 0 24 24" width="36" height="36">
          <path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12S6.48 22 12 22 22 17.52 22 12 17.52 2 12 2M13 17H11V15H13V17M13 13H11V7H13V13Z"/>
        </svg>
      </div>
      <div>
        <h4 style="font-family: 'Outfit', sans-serif; font-size: 16px; font-weight: 600; color: #fff; margin-bottom: 6px;">Failed to Retrieve Snapshots</h4>
        <p class="card-subtitle" style="margin: 0; max-width: 480px; color: var(--color-danger);"><strong>Error: Could not retrieve snapshots registry from the server.</strong></p>
        <p class="card-subtitle" style="font-size: 12px; margin-top: 4px;">Check backend console logs or verify the local server is operating correctly.</p>
      </div>
    </div>
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
    if (settingsRetentionCount) settingsRetentionCount.value = settings.retentionCount || 0;
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
    const response = await fetch(`/api/git/status?project=${currentProject}&_=${Date.now()}`);
    if (!response.ok) throw new Error('API Error');
    const data = await response.json();

    if (gitBranchVal) gitBranchVal.textContent = data.branch || 'main';
    if (gitModifiedCount) gitModifiedCount.textContent = data.modifiedCount || '0';
    if (gitUntrackedCount) gitUntrackedCount.textContent = data.untrackedCount || '0';

    const totalChanged = (data.modifiedCount || 0) + (data.untrackedCount || 0);
    const totalFiles = (data.files && data.files.length) || 0;

    // Update file progress bar
    if (gitFileProgressContainer && totalFiles > 0) {
      gitFileProgressContainer.style.display = 'block';
      if (gitFileProgressText) {
        gitFileProgressText.textContent = `${totalChanged} / ${totalFiles}`;
      }
      if (gitFileProgressBar) {
        const pct = totalFiles > 0 ? Math.round((totalChanged / totalFiles) * 100) : 0;
        gitFileProgressBar.style.width = `${pct}%`;
      }
    } else if (gitFileProgressContainer) {
      gitFileProgressContainer.style.display = 'none';
    }

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

// --- Reset Git Deployment progress UI ---
function resetGitDeployUI() {
  updateProgress(0);
  if (gitDeployProgressPct) gitDeployProgressPct.textContent = '0%';
  if (gitDeployProgressFill) gitDeployProgressFill.style.width = '0%';
  if (gitDeployStatusText) {
    gitDeployStatusText.textContent = 'Deployment pipeline running...';
  }
  const gitDeployProgressCard = document.getElementById('git-deploy-progress-card');
  if (gitDeployProgressCard) gitDeployProgressCard.classList.add('is-active');
  resetStepper();
}

function stopGitParityPolling() {
  if (gitParityInterval) {
    clearInterval(gitParityInterval);
    gitParityInterval = null;
  }
}

function startGitParityPolling() {
  if (gitParityInterval) return;
  gitParityInterval = setInterval(() => {
    if (activeTask.status !== 'running') {
      loadVersionParity();
    }
  }, 8000);
}

function updateGitCicdBanner(data) {
  if (!gitCicdStatusBanner) return;
  const cicdActive = data.remote && data.server && data.remote !== data.server && !data.localDirty;
  if (cicdActive) {
    gitCicdStatusBanner.style.display = 'flex';
    if (gitCicdStatusText) {
      gitCicdStatusText.textContent = `CI/CD syncing — remote ${data.remoteShort} → server ${data.serverShort || 'pending'}`;
    }
    startGitParityPolling();
  } else {
    gitCicdStatusBanner.style.display = 'none';
    if (!data.remote || !data.server || data.parity) {
      stopGitParityPolling();
    }
  }
}

// --- Stepper Controls helper ---
function resetStepper() {
  const steps = [stepGitCommit, stepGitPush, stepGitVps, stepGitCicd, stepGitVerify];
  steps.forEach(step => {
    if (step) step.className = 'monitor-step step-pending';
  });
  ['step-progress-commit', 'step-progress-push', 'step-progress-vps', 'step-progress-cicd', 'step-progress-verify'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = '';
      el.style.color = '';
    }
  });
}

function setStepStatus(stepElement, status) {
  if (!stepElement) return;
  stepElement.className = `monitor-step step-${status}`;
}

function updateStepperFromLog(text) {
  const stepMatch = text.match(/\[STEP (\d+)\/(\d+)\]/);
  if (stepMatch) {
    const stepNum = parseInt(stepMatch[1], 10);
    const allSteps = [stepGitCommit, stepGitPush, stepGitVps, stepGitCicd, stepGitVerify];
    const progressIds = ['step-progress-commit', 'step-progress-push', 'step-progress-vps', 'step-progress-cicd', 'step-progress-verify'];

    allSteps.forEach((step, idx) => {
      const n = idx + 1;
      if (stepNum > n) setStepStatus(step, 'completed');
      else if (stepNum === n) setStepStatus(step, 'running');
    });

    const progressMatch = text.match(/\[PROGRESS\]\s*(\d+)%/);
    if (progressMatch) {
      const pct = parseInt(progressMatch[1], 10);
      const progressEl = document.getElementById(progressIds[stepNum - 1]);
      if (progressEl) {
        progressEl.textContent = `${pct}%`;
        progressEl.style.color = pct >= 100 ? 'var(--green)' : 'var(--text-desc)';
      }
    }
    return;
  }

  if (text.includes('Changes committed successfully') || text.includes('Working tree clean')) {
    setStepStatus(stepGitCommit, 'completed');
  }
  if (text.includes('Successfully pushed to GitHub') || text.includes('GitHub remote is already up to date')) {
    setStepStatus(stepGitCommit, 'completed');
    setStepStatus(stepGitPush, 'completed');
  }
  if (text.includes('VPS state verified') || text.includes('Snapshot uploaded to VPS successfully')) {
    setStepStatus(stepGitCommit, 'completed');
    setStepStatus(stepGitPush, 'completed');
    setStepStatus(stepGitVps, 'completed');
  }
  if (text.includes('VPS code has fully deployed and synchronized') || text.includes('SUCCESS: VPS code has fully deployed')) {
    setStepStatus(stepGitCommit, 'completed');
    setStepStatus(stepGitPush, 'completed');
    setStepStatus(stepGitVps, 'completed');
    setStepStatus(stepGitCicd, 'completed');
  }
  if (text.includes('Parity & health verification completed') || text.includes('[Recovery State Completed...]')) {
    allStepsComplete();
  }
  if (text.includes('[Recovery State Completed with warnings...]')) {
    setStepStatus(stepGitCommit, 'completed');
    setStepStatus(stepGitPush, 'completed');
    setStepStatus(stepGitVps, 'completed');
    setStepStatus(stepGitCicd, 'completed');
    setStepStatus(stepGitVerify, 'failed');
  }
}

function allStepsComplete() {
  [stepGitCommit, stepGitPush, stepGitVps, stepGitCicd, stepGitVerify].forEach(step => {
    setStepStatus(step, 'completed');
  });
}



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

  if (task.status === 'running') {
    lastTaskType = task.taskType;
    
    // Disable inputs
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
    if (gitIncludeDb) gitIncludeDb.disabled = true;
    if (gitDbConfirm) gitDbConfirm.disabled = true;
    
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
    explorerSubmitBtn.disabled = false;
    explorerSubmitBtn.textContent = 'Take Snapshot';
    refreshSnapshotsBtn.disabled = false;
    
    // Enable Settings & Git inputs
    if (settingsSaveBtn) {
      settingsSaveBtn.disabled = false;
      settingsSaveBtn.textContent = 'Save Settings';
    }
    if (gitDeployBtn) {
      gitDeployBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="18" height="18" style="margin-right: 6px;">
          <path fill="currentColor" d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
        </svg>
        Push to Git
      `;
      validateGitForm();
    }
    if (gitRefreshBtn) gitRefreshBtn.disabled = false;
    if (gitCommitMessage) gitCommitMessage.disabled = false;
    if (gitIncludeDb) gitIncludeDb.disabled = false;
    if (gitDbConfirm) gitDbConfirm.disabled = false;

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
    const gitDeployProgressCard = document.getElementById('git-deploy-progress-card');
    if (code === 0) {
      allStepsComplete();
      updateProgress(100);
      if (gitDeployStatusText) {
        gitDeployStatusText.textContent = 'Deployment complete — all pipeline steps finished successfully.';
      }
      showToast('Production deployment completed successfully!', 'success');
    } else {
      const steps = [stepGitCommit, stepGitPush, stepGitVps, stepGitCicd, stepGitVerify];
      const runningStep = steps.find(s => s && s.classList.contains('step-running'));
      if (runningStep) {
        setStepStatus(runningStep, 'failed');
      } else {
        setStepStatus(stepGitVerify, 'failed');
      }
      if (gitDeployStatusText) {
        gitDeployStatusText.textContent = `Deployment failed (exit code ${code}). Check the console for details.`;
      }
      if (gitDeployProgressCard) gitDeployProgressCard.classList.remove('is-active');
      showToast(`Deployment pipeline failed with exit code: ${code}`, 'error');
    }
    loadGitStatus();
    loadVersionParity();
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

// --- Action: Take Snapshot ---
explorerSnapshotForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  if (activeTask.status === 'running') {
    showToast('A backup or recovery action is currently executing.', 'warning');
    return;
  }

  const desc = explorerDescInput.value.trim();
  const live = explorerLiveCheck.checked;
  const backupLevel = explorerLevelSelect.value;
  const noDb = (backupLevel === 'Low');

  // Convert comma-separated exclusions input to array of relative paths
  const excludesStr = explorerExcludePaths ? explorerExcludePaths.value.trim() : '';
  const excludePaths = excludesStr
    ? excludesStr.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  await triggerSnapshotCreation({
    project: currentProject,
    description: desc,
    live,
    noDb,
    backupLevel,
    excludePaths
  });

  explorerDescInput.value = '';
  if (explorerExcludePaths) explorerExcludePaths.value = '';
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
      vpsInstallRoot: settingsVpsRoot.value.trim(),
      retentionCount: parseInt(settingsRetentionCount ? settingsRetentionCount.value : '0', 10) || 0
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
  const includeDb = gitIncludeDb && gitIncludeDb.checked;
  const confirmOk = !includeDb || (gitDbConfirm && gitDbConfirm.value.trim().toUpperCase() === 'FULL');
  const isDisabled = !commitMsg || !confirmOk;
  if (gitDeployBtn) {
    gitDeployBtn.disabled = isDisabled;
  }
}

// --- Action: Trigger Git Push ---
if (gitDeployForm) {
  gitDeployForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (activeTask.status === 'running') {
      showToast('A task is currently executing.', 'warning');
      return;
    }

    const commitMessage = gitCommitMessage.value.trim();
    if (!commitMessage) {
      showToast('A commit message is required.', 'warning');
      return;
    }

    const includeDb = gitIncludeDb && gitIncludeDb.checked;
    if (includeDb) {
      const confirmText = gitDbConfirm ? gitDbConfirm.value.trim().toUpperCase() : '';
      if (confirmText !== 'FULL') {
        showToast('Type FULL to confirm database overwrite.', 'warning');
        return;
      }
    }

    resetGitDeployUI();

    try {
      const response = await fetch('/api/git/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commitMessage,
          project: currentProject,
          overwriteDb: includeDb,
          dbConfirm: includeDb ? 'FULL' : undefined
        })
      });

      if (response.ok) {
        showToast(includeDb ? 'Git push with database seed started. Monitoring progress...' : 'Git push started. Monitoring progress...', 'success');
        gitCommitMessage.value = '';
        if (gitIncludeDb) {
          gitIncludeDb.checked = false;
          if (gitDbWarning) gitDbWarning.style.display = 'none';
        }
        if (gitDbConfirm) gitDbConfirm.value = '';
        validateGitForm();
      } else {
        const err = await response.json();
        showToast(`Push failed: ${err.error}`, 'error');
        setStepStatus(stepGitCommit, 'failed');
      }
    } catch (err) {
      showToast('Failed to contact server.', 'error');
      setStepStatus(stepGitCommit, 'failed');
    }
  });
}

// Git Deployment form input validation listeners
if (gitCommitMessage) {
  gitCommitMessage.addEventListener('input', validateGitForm);
}
if (gitIncludeDb) {
  gitIncludeDb.addEventListener('change', () => {
    if (gitDbWarning) {
      gitDbWarning.style.display = gitIncludeDb.checked ? 'block' : 'none';
    }
    if (!gitIncludeDb.checked && gitDbConfirm) {
      gitDbConfirm.value = '';
    }
    validateGitForm();
  });
}
if (gitDbConfirm) {
  gitDbConfirm.addEventListener('input', validateGitForm);
}

// --- Load Version Parity (local vs remote vs server) ---
async function loadVersionParity() {
  if (!currentProject) return;

  // Update UI to loading state
  if (gitParityText) gitParityText.textContent = 'Checking versions...';
  if (gitParityIndicator) gitParityIndicator.style.background = 'var(--border-subtle)';
  if (gitVersionLocal) gitVersionLocal.textContent = '...';
  if (gitVersionRemote) gitVersionRemote.textContent = '...';
  if (gitVersionServer) gitVersionServer.textContent = '...';

  // Reset icons
  [gitVersionLocalIcon, gitVersionRemoteIcon, gitVersionServerIcon].forEach(el => {
    if (el) el.innerHTML = '';
  });

  try {
    const response = await fetch(`/api/git/versions?project=${currentProject}&_=${Date.now()}`);
    if (!response.ok) throw new Error('API Error');
    const data = await response.json();

    // Update hash displays
    if (gitVersionLocal) {
      gitVersionLocal.textContent = (data.localShort || '—') + (data.localDirty ? ' *' : '');
    }
    if (gitVersionRemote) gitVersionRemote.textContent = data.remoteShort || '—';
    if (gitVersionServer) {
      gitVersionServer.textContent = (data.serverShort || '—') + (data.serverDirty ? ' *' : '');
    }

    // Update individual match icons
    const checkIcon = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="var(--green)" d="M12 2C6.5 2 2 6.5 2 12S6.5 22 12 22 22 17.5 22 12 17.5 2 12 2M10 17L5 12L6.41 10.59L10 14.17L17.59 6.58L19 8L10 17Z"/></svg>';
    const crossIcon = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="var(--red)" d="M12 2C6.47 2 2 6.47 2 12S6.47 22 12 22 22 17.53 22 12 17.53 2 12 2M17 15.59L15.59 17L12 13.41L8.41 17L7 15.59L10.59 12L7 8.41L8.41 7L12 10.59L15.59 7L17 8.41L13.41 12L17 15.59Z"/></svg>';
    const dashIcon = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="var(--text-desc)" d="M20 13H4V11H20V13Z"/></svg>';

    // Determine icon for each slot
    if (data.local && data.remote && data.local === data.remote) {
      if (gitVersionLocalIcon) gitVersionLocalIcon.innerHTML = checkIcon;
      if (gitVersionRemoteIcon) gitVersionRemoteIcon.innerHTML = checkIcon;
    } else if (data.local && data.remote) {
      if (gitVersionLocalIcon) gitVersionLocalIcon.innerHTML = crossIcon;
      if (gitVersionRemoteIcon) gitVersionRemoteIcon.innerHTML = crossIcon;
    } else {
      if (gitVersionLocalIcon) gitVersionLocalIcon.innerHTML = dashIcon;
      if (gitVersionRemoteIcon) gitVersionRemoteIcon.innerHTML = dashIcon;
    }

    if (data.server && data.local && data.server === data.local) {
      if (gitVersionServerIcon) gitVersionServerIcon.innerHTML = checkIcon;
    } else if (data.server) {
      if (gitVersionServerIcon) gitVersionServerIcon.innerHTML = crossIcon;
    } else {
      if (gitVersionServerIcon) gitVersionServerIcon.innerHTML = dashIcon;
    }

    // Update parity banner
    if (data.localDirty) {
      if (gitParityIndicator) gitParityIndicator.style.background = 'var(--yellow)';
      if (gitParityText) {
        gitParityText.textContent = 'Local workspace has uncommitted changes — commit to track.';
        gitParityText.style.color = 'var(--yellow)';
      }
      updateGitCicdBanner(data);
    } else if (data.parity) {
      if (gitParityIndicator) gitParityIndicator.style.background = 'var(--green)';
      if (gitParityText) {
        gitParityText.textContent = 'All three versions match — parity achieved. Server is ready for testing.';
        gitParityText.style.color = 'var(--green)';
      }
    } else {
      if (gitParityIndicator) gitParityIndicator.style.background = 'var(--yellow)';
      if (gitParityText) {
        if (data.localAhead) {
          gitParityText.textContent = 'Local is ahead of remote — push your commits.';
        } else if (!data.remote) {
          gitParityText.textContent = 'Could not reach GitHub remote. Check network.';
        } else if (!data.server) {
          gitParityText.textContent = 'Could not reach production server. Check SSH/network.';
        } else if (!data.local) {
          gitParityText.textContent = 'Local git repository not found.';
        } else {
          gitParityText.textContent = 'Versions are out of sync. Push changes or wait for CI/CD.';
        }
        gitParityText.style.color = 'var(--yellow)';
      }
    }

    updateGitCicdBanner(data);

    // Highlight matching boxes
    const allBoxes = [
      document.getElementById('git-version-local-box'),
      document.getElementById('git-version-remote-box'),
      document.getElementById('git-version-server-box')
    ];
    allBoxes.forEach(box => {
      if (box) box.style.borderColor = data.parity && !data.localDirty ? 'var(--green)' : 'var(--border-subtle)';
    });
    // Local box gets warning border when dirty
    if (data.localDirty) {
      const localBox = document.getElementById('git-version-local-box');
      if (localBox) localBox.style.borderColor = 'var(--yellow)';
    }

  } catch (err) {
    if (gitParityText) {
      gitParityText.textContent = 'Failed to check version parity.';
      gitParityText.style.color = 'var(--red)';
    }
    if (gitParityIndicator) gitParityIndicator.style.background = 'var(--red)';
  }
}

// Version parity refresh button
if (gitVersionsRefreshBtn) {
  gitVersionsRefreshBtn.addEventListener('click', () => {
    loadVersionParity();
    showToast('Refreshing version parity...', 'info');
  });
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

  // Toggle port conflict warning inside restore modal
  const modalRestorePortWarning = document.getElementById('modal-restore-port-warning');
  if (modalRestorePortWarning) {
    modalRestorePortWarning.style.display = hasPortConflict ? 'block' : 'none';
  }

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

projectSelect.addEventListener('change', async (e) => {
  currentProject = e.target.value;
  await loadProjectSnapshots(currentProject);
  await loadSettings();
  await loadGitStatus();
  loadVersionParity();
  checkLocalPorts();
  const activeTabItem = document.querySelector('.nav-item.active');
  if (activeTabItem && activeTabItem.getAttribute('data-tab') === 'parity') {
    startStatsPolling();
    startLocalHealthPolling();
  }
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
        body: JSON.stringify({ path: pathVal })
      });
      
      if (response.ok) {
        showToast('Project mapping added successfully!', 'success');
        if (addProjectModal) addProjectModal.classList.remove('active');
        
        // Auto-select newly added project based on its folder name
        const pathParts = pathVal.replace(/\\/g, '/').split('/');
        const nameCandidate = pathParts.pop() || pathParts.pop();
        if (nameCandidate) {
          currentProject = nameCandidate;
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

if (deleteProjectBtn) {
  deleteProjectBtn.addEventListener('click', async () => {
    if (!currentProject) {
      showToast('No project selected to remove.', 'warning');
      return;
    }
    
    if (currentProject.toLowerCase() === 'mypools') {
      showToast('The default project "mypools" cannot be deleted.', 'warning');
      return;
    }
    
    const confirmRemove = confirm(`Are you sure you want to remove project "${currentProject}" from the console?\nThis will not delete the project files or snapshots on disk, just the mapping in this dashboard.`);
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
  gitSnapshotSelect.addEventListener('change', (e) => {
    validateGitForm();
    loadGitDiffPreview(e.target.value);
  });
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
  initLogsStream();
  
  // Bind git diff card toggle
  const gitDiffHeader = document.getElementById('git-diff-header');
  const gitDiffToggleBtn = document.getElementById('git-diff-toggle-btn');
  const gitDiffDetailedContent = document.getElementById('git-diff-detailed-content');
  if (gitDiffHeader) {
    gitDiffHeader.addEventListener('click', () => {
      if (gitDiffDetailedContent) {
        const isHidden = gitDiffDetailedContent.style.display === 'none';
        gitDiffDetailedContent.style.display = isHidden ? 'block' : 'none';
        if (gitDiffToggleBtn) {
          gitDiffToggleBtn.textContent = isHidden ? 'Hide Details' : 'Show Details';
        }
      }
    });
  }

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

let hasPortConflict = false;
let statsPollInterval = null;

function startStatsPolling() {
  stopStatsPolling();
  pollContainerStats(); // run immediately
  statsPollInterval = setInterval(pollContainerStats, 6000);
}

function stopStatsPolling() {
  if (statsPollInterval) {
    clearInterval(statsPollInterval);
    statsPollInterval = null;
  }
}

async function checkLocalPorts() {
  const portsLoading = document.getElementById('ports-loading');
  const portsList = document.getElementById('ports-list');
  const portsOkAlert = document.getElementById('ports-ok-alert');
  const portsConflictAlert = document.getElementById('ports-conflict-alert');
  const modalRestorePortWarning = document.getElementById('modal-restore-port-warning');

  if (!currentProject) return;

  if (portsLoading) portsLoading.style.display = 'block';
  if (portsList) portsList.style.display = 'none';
  if (portsOkAlert) portsOkAlert.style.display = 'none';
  if (portsConflictAlert) portsConflictAlert.style.display = 'none';

  try {
    const response = await fetch(`/api/project/check-ports?project=${currentProject}`);
    if (!response.ok) throw new Error('API Error');
    const data = await response.json();

    if (portsLoading) portsLoading.style.display = 'none';
    if (portsList) {
      portsList.innerHTML = '';
      portsList.style.display = 'flex';
    }

    if (!data.ports || data.ports.length === 0) {
      if (portsOkAlert) portsOkAlert.style.display = 'block';
      hasPortConflict = false;
      if (modalRestorePortWarning) modalRestorePortWarning.style.display = 'none';
      return;
    }

    let conflictFound = false;
    data.ports.forEach(p => {
      const portItem = document.createElement('div');
      portItem.className = `port-item ${p.free ? 'port-free' : 'port-occupied'}`;
      portItem.style.display = 'flex';
      portItem.style.justifyContent = 'space-between';
      portItem.style.alignItems = 'center';
      portItem.style.padding = '8px 12px';
      portItem.style.borderRadius = 'var(--radius-sm)';
      portItem.style.border = '1px solid var(--border-subtle)';
      portItem.style.fontSize = '13px';

      const statusBadge = p.free 
        ? '<span class="badge badge-success" style="font-size: 11px;">Free</span>' 
        : '<span class="badge badge-danger" style="font-size: 11px;">Occupied</span>';

      if (!p.free) {
        conflictFound = true;
      }

      portItem.innerHTML = `
        <span style="font-family: var(--font-family-mono); color: #fff;">Port ${p.port} <span style="color: var(--text-desc); font-size: 12px;">(${p.service} &rarr; ${p.containerPort})</span></span>
        ${statusBadge}
      `;
      portsList.appendChild(portItem);
    });

    hasPortConflict = conflictFound;

    if (conflictFound) {
      if (portsConflictAlert) portsConflictAlert.style.display = 'block';
      if (portsOkAlert) portsOkAlert.style.display = 'none';
    } else {
      if (portsOkAlert) portsOkAlert.style.display = 'block';
      if (portsConflictAlert) portsConflictAlert.style.display = 'none';
    }
  } catch (err) {
    console.error('Port checking failed:', err);
    if (portsLoading) portsLoading.style.display = 'none';
    showToast('Failed to verify local ports.', 'error');
  }
}

async function pollContainerStats() {
  const resourcesLoading = document.getElementById('resources-loading');
  const resourcesList = document.getElementById('resources-list');
  const resourcesEmpty = document.getElementById('resources-empty');

  if (!currentProject) return;

  try {
    const response = await fetch(`/api/containers/stats?project=${currentProject}`);
    if (!response.ok) throw new Error('API Error');
    const data = await response.json();

    if (resourcesLoading) resourcesLoading.style.display = 'none';

    if (!data.stats || data.stats.length === 0) {
      if (resourcesList) resourcesList.style.display = 'none';
      if (resourcesEmpty) resourcesEmpty.style.display = 'block';
      return;
    }

    if (resourcesEmpty) resourcesEmpty.style.display = 'none';
    if (resourcesList) {
      resourcesList.innerHTML = '';
      resourcesList.style.display = 'flex';
    }

    data.stats.forEach(s => {
      const cpuVal = parseFloat(s.cpu) || 0;
      const memVal = parseFloat(s.memPerc) || 0;

      const containerEl = document.createElement('div');
      containerEl.className = 'container-stat-row';
      containerEl.style.display = 'flex';
      containerEl.style.flexDirection = 'column';
      containerEl.style.gap = '6px';
      containerEl.style.padding = '10px 12px';
      containerEl.style.borderRadius = 'var(--radius-md)';
      containerEl.style.backgroundColor = 'rgba(255, 255, 255, 0.02)';
      containerEl.style.border = '1px solid var(--border-subtle)';

      const cleanName = s.name.replace(/^[a-zA-Z0-9_\-]+_(mysql|redis|php|nginx|web|db)_[0-9]+$/, '$1')
                             .replace(/^[a-zA-Z0-9_\-]+_(mysql|redis|php|nginx|web|db)$/, '$1');

      containerEl.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-weight: 600; color: #fff; font-size: 13px;">${cleanName}</span>
          <span style="font-size: 11px; color: var(--text-desc); font-family: var(--font-family-mono);">${s.netIo}</span>
        </div>
        
        <!-- CPU Stat -->
        <div style="display: flex; flex-direction: column; gap: 2px;">
          <div style="display: flex; justify-content: space-between; font-size: 11px; color: var(--text-desc);">
            <span>CPU Usage</span>
            <span style="font-family: var(--font-family-mono); color: #fff;">${s.cpu}</span>
          </div>
          <div class="progress-bar-container" style="height: 6px; background-color: rgba(255,255,255,0.05); border-radius: 3px; overflow: hidden; margin-top: 2px;">
            <div class="progress-bar-fill stats-cpu-fill" style="width: ${Math.min(100, cpuVal)}%; height: 100%; border-radius: 3px; background: linear-gradient(90deg, #14b8a6, #0d9488); transition: width 0.4s ease;"></div>
          </div>
        </div>

        <!-- Memory Stat -->
        <div style="display: flex; flex-direction: column; gap: 2px; margin-top: 4px;">
          <div style="display: flex; justify-content: space-between; font-size: 11px; color: var(--text-desc);">
            <span>Memory (${s.memUsage})</span>
            <span style="font-family: var(--font-family-mono); color: #fff;">${s.memPerc}</span>
          </div>
          <div class="progress-bar-container" style="height: 6px; background-color: rgba(255,255,255,0.05); border-radius: 3px; overflow: hidden; margin-top: 2px;">
            <div class="progress-bar-fill stats-mem-fill" style="width: ${Math.min(100, memVal)}%; height: 100%; border-radius: 3px; background: linear-gradient(90deg, #6366f1, #4f46e5); transition: width 0.4s ease;"></div>
          </div>
        </div>
      `;
      resourcesList.appendChild(containerEl);
    });

  } catch (err) {
    console.error('Resource stats polling failed:', err);
    if (resourcesLoading) resourcesLoading.style.display = 'none';
  }
}

async function loadGitDiffPreview(snapshotName) {
  const gitDiffCard = document.getElementById('git-diff-card');
  const gitDiffStatusBadge = document.getElementById('git-diff-status-badge');
  const gitDiffSummaryContent = document.getElementById('git-diff-summary-content');
  const gitDiffPre = document.getElementById('git-diff-pre');

  if (!snapshotName) {
    if (gitDiffCard) gitDiffCard.style.display = 'none';
    return;
  }

  if (gitDiffCard) gitDiffCard.style.display = 'block';
  if (gitDiffStatusBadge) {
    gitDiffStatusBadge.className = 'badge badge-muted';
    gitDiffStatusBadge.textContent = 'Loading Diff...';
  }
  if (gitDiffSummaryContent) {
    gitDiffSummaryContent.innerHTML = `
      <div class="loading-state" style="padding: 10px 0; width: 100%; display: flex; align-items: center; gap: 8px;">
        <div class="spinner" style="width: 16px; height: 16px;"></div>
        Querying git diff preview...
      </div>
    `;
  }
  if (gitDiffPre) gitDiffPre.textContent = 'Loading diff details...';

  try {
    const response = await fetch(`/api/git/diff-preview?project=${currentProject}&snapshotName=${snapshotName}`);
    if (!response.ok) throw new Error('API Error');
    const data = await response.json();

    if (data.isFallback) {
      if (gitDiffStatusBadge) {
        gitDiffStatusBadge.className = 'badge badge-warning';
        gitDiffStatusBadge.textContent = 'Fallback Diff';
      }
      if (gitDiffSummaryContent) {
        gitDiffSummaryContent.innerHTML = `
          <div class="alert-box alert-warning" style="margin: 0; width: 100%;">
            <strong>Warning:</strong> ${data.warning || 'Could not reach VPS for production commit. Comparing snapshot commit against local HEAD.'}
          </div>
        `;
      }
    } else {
      if (gitDiffStatusBadge) {
        gitDiffStatusBadge.className = 'badge badge-teal';
        gitDiffStatusBadge.textContent = 'VPS vs Snapshot';
      }
      
      let summaryText = 'No changes between VPS and Snapshot.';
      if (data.diff && data.diff !== 'No changes') {
        const lines = data.diff.split('\n');
        const lastLine = lines[lines.length - 1];
        if (lastLine && (lastLine.includes('changed') || lastLine.includes('insertion') || lastLine.includes('deletion'))) {
          summaryText = lastLine.trim();
        } else {
          summaryText = 'Differences detected. Expand details to see file changes.';
        }
      }

      if (gitDiffSummaryContent) {
        gitDiffSummaryContent.innerHTML = `
          <div class="alert-box alert-success" style="margin: 0; width: 100%; display: flex; align-items: center; justify-content: space-between;">
            <span><strong>Diff Summary:</strong> ${summaryText}</span>
            <span style="font-family: var(--font-family-mono); font-size: 11px; opacity: 0.8;">VPS: ${data.vpsCommit ? data.vpsCommit.substring(0, 8) : 'N/A'} &rarr; Snap: ${data.snapshotCommit ? data.snapshotCommit.substring(0, 8) : 'N/A'}</span>
          </div>
        `;
      }
    }

    if (gitDiffPre) {
      gitDiffPre.textContent = data.diff || 'No changes';
    }

  } catch (err) {
    console.error('Git diff preview failed:', err);
    if (gitDiffStatusBadge) {
      gitDiffStatusBadge.className = 'badge badge-danger';
      gitDiffStatusBadge.textContent = 'Error';
    }
    if (gitDiffSummaryContent) {
      gitDiffSummaryContent.innerHTML = `
        <div class="alert-box alert-danger" style="margin: 0; width: 100%;">
          Failed to load git diff preview.
        </div>
      `;
    }
    if (gitDiffPre) gitDiffPre.textContent = 'Error fetching git diff details.';
  }
}

// ============================================================
//   LOCAL HEALTH & PATHS TAB
// ============================================================

let localHealthPollInterval = null;

function startLocalHealthPolling() {
  stopLocalHealthPolling();
  loadLocalHealth(); // run immediately
  loadServerStatus();
  localHealthPollInterval = setInterval(() => {
    loadLocalHealth();
    loadServerStatus();
  }, 6000);
}

function stopLocalHealthPolling() {
  if (localHealthPollInterval) {
    clearInterval(localHealthPollInterval);
    localHealthPollInterval = null;
  }
}

async function loadLocalHealth() {
  if (!currentProject) return;

  try {
    const response = await fetch(`/api/local-health?project=${currentProject}`);
    if (!response.ok) throw new Error('API Error');
    const data = await response.json();
    renderLocalContainers(data.containers);
    renderLocalDbConnectivity(data.diagnostics.dbConnectivity);
    renderLocalHttpConnectivity(data.diagnostics.httpConnectivity);
    renderLocalDiagnostics(data.diagnostics, data.network);
    renderLocalPaths(data.network);
    renderLocalBackups(data.backups);
  } catch (err) {
    const grid = document.getElementById('local-containers-grid');
    if (grid) {
      grid.innerHTML = `<div class="alert-box alert-danger" style="grid-column:1/-1">
        Failed to load local health data. Is the server running?
      </div>`;
    }
  }
}

// --- Containers Grid ---
function renderLocalContainers(containers) {
  const grid = document.getElementById('local-containers-grid');
  if (!grid) return;

  const services = ['php', 'nginx', 'mysql', 'redis', 'edge'];
  const icons = {
    php:   'M12 2A10 10 0 1 0 22 12A10 10 0 0 0 12 2M12 4A8 8 0 1 1 4 12A8 8 0 0 1 12 4M11 17V15H13V17H11M11 7H13V13H11Z',
    nginx: 'M12 2L1 21H23L12 2M12 6L19.5 19H4.5L12 6M11 9V13H13V9H11M11 15V17H13V15H11Z',
    mysql: 'M12 3C7 3 3 5.7 3 9V15C3 18.3 7 21 12 21S21 18.3 21 15V9C21 5.7 17 3 12 3M19 9C19 11.2 15.9 13 12 13S5 11.2 5 9 8.1 5 12 5 19 6.8 19 9M5 11.7C6.8 13.1 9.3 14 12 14S17.2 13.1 19 11.7V15C19 17.2 15.9 19 12 19S5 17.2 5 15V11.7Z',
    redis: 'M21 16.5C21 17.9 17.4 19 13 19S5 17.9 5 16.5V13.7C6.8 14.6 9.8 15.2 13 15.2S19.2 14.6 21 13.7V16.5M21 11C21 12.4 17.4 13.5 13 13.5S5 12.4 5 11V8.2C6.8 9.1 9.8 9.7 13 9.7S19.2 9.1 21 8.2V11M13 4C17.4 4 21 5.1 21 6.5S17.4 9 13 9 5 7.9 5 6.5 8.6 4 13 4Z',
    edge:  'M12 2A10 10 0 0 0 2 12A10 10 0 0 0 12 22A10 10 0 0 0 22 12A10 10 0 0 0 12 2M11 17V15H13V17H11M12 4A8 8 0 0 1 20 12H18A6 6 0 0 0 12 6V4M12 8A4 4 0 0 1 16 12H14A2 2 0 0 0 12 10V8Z'
  };
  const colors = {
    php:   '#6366f1',
    nginx: '#0ea5e9',
    mysql: '#f59e0b',
    redis: '#ef4444',
    edge:  '#10b981'
  };

  grid.innerHTML = services.map(svc => {
    const info = (containers && containers[svc]) || { status: 'missing', name: '', rawStatus: '' };
    const isRunning = info.status === 'running';
    const isStopped = info.status === 'stopped';
    const dotClass = isRunning ? 'running' : isStopped ? 'stopped' : 'missing';
    const statusLabel = isRunning ? 'Running' : isStopped ? 'Stopped' : 'Not Found';
    const statusColor = isRunning ? '#10b981' : isStopped ? '#f43f5e' : '#64748b';
    const borderColor = isRunning ? 'rgba(16,185,129,0.25)' : isStopped ? 'rgba(244,63,94,0.25)' : 'var(--border-subtle)';

    const healButtonHtml = !isRunning ? `
      <button class="btn btn-secondary btn-xs heal-service-btn" data-service="${svc}" style="margin-top: 8px; font-size: 11px; padding: 4px 8px; width: fit-content; display: flex; align-items: center; gap: 4px;">
        <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
        </svg>
        Heal Service
      </button>
    ` : '';

    return `
      <div class="health-container-card" style="border-color: ${borderColor};">
        <div class="health-card-header">
          <div style="display:flex; align-items:center; gap:8px;">
            <div style="width:32px;height:32px;border-radius:8px;background:${colors[svc]}18;border:1px solid ${colors[svc]}33;display:flex;align-items:center;justify-content:center;">
              <svg viewBox="0 0 24 24" width="16" height="16" style="color:${colors[svc]}">
                <path fill="currentColor" d="${icons[svc]}"/>
              </svg>
            </div>
            <span class="health-service-name">${svc}</span>
          </div>
          <div class="health-status-badge" style="color:${statusColor}">
            <span class="health-status-dot ${dotClass}"></span>
            ${statusLabel}
          </div>
        </div>
        <div style="display: flex; flex-direction: column; justify-content: space-between; height: 100%;">
          <div>
            ${info.name ? `<div class="health-container-name">${info.name}</div>` : ''}
            <div class="health-card-details">${info.rawStatus || 'No status available'}</div>
          </div>
          ${healButtonHtml}
        </div>
      </div>
    `;
  }).join('');

  grid.querySelectorAll('.heal-service-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const service = btn.getAttribute('data-service');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner" style="width:10px;height:10px;margin-right:4px;"></span> Healing...';
      try {
        const response = await fetch('/api/local-health/fix', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: currentProject, type: 'heal-service', service })
        });
        const resData = await response.json();
        if (resData.success) {
          showToast(`Healing task started for service "${service}".`, 'success');
        } else {
          showToast(`Failed to heal "${service}": ${resData.error}`, 'error');
        }
      } catch (err) {
        showToast(`Error triggering heal action: ${err.message}`, 'error');
      } finally {
        loadLocalHealth(); // refresh UI
      }
    });
  });
}

// --- DB Connectivity Panel ---
function renderLocalDbConnectivity(dbTest) {
  const panel = document.getElementById('local-db-connectivity');
  if (!panel) return;

  const isOk = dbTest && dbTest.status === 'ok';
  const color = isOk ? 'var(--color-teal)' : 'var(--color-danger)';
  const icon = isOk
    ? 'M21 7L9 19L3.5 13.5L4.91 12.09L9 16.17L19.59 5.59L21 7Z'
    : 'M12 2C6.47 2 2 6.47 2 12S6.47 22 12 22 22 17.53 22 12 17.53 2 12 2M17 15.59L15.59 17L12 13.41L8.41 17L7 15.59L10.59 12L7 8.41L8.41 7L12 10.59L15.59 7L17 8.41L13.41 12L17 15.59Z';

  panel.innerHTML = `
    <div class="db-connectivity-info">
      <div class="db-connectivity-icon" style="background-color: ${isOk ? 'rgba(0,210,196,0.1)' : 'rgba(244,63,94,0.1)'}; border-color: ${isOk ? 'rgba(0,210,196,0.2)' : 'rgba(244,63,94,0.2)'}; color: ${color};">
        <svg viewBox="0 0 24 24" width="20" height="20">
          <path fill="currentColor" d="${icon}"/>
        </svg>
      </div>
      <div class="db-connectivity-text">
        <h4>MariaDB Connection Test</h4>
        <p>${(dbTest && dbTest.message) || 'Testing database connectivity inside MySQL container...'}</p>
      </div>
    </div>
    <div class="db-connectivity-status" style="color: ${color};">
      ${isOk ? '✓ Connected' : '✗ Failed'}
    </div>
  `;
}

// --- HTTP Connectivity Panel ---
function renderLocalHttpConnectivity(httpConnectivity) {
  const homescreenPanel = document.getElementById('local-http-homescreen');
  const wordpressPanel = document.getElementById('local-http-wordpress');

  if (homescreenPanel && httpConnectivity && httpConnectivity.homescreen) {
    const check = httpConnectivity.homescreen;
    const isOk = check.ok;
    const color = isOk ? 'var(--color-teal)' : 'var(--color-danger)';
    const icon = isOk
      ? 'M21 7L9 19L3.5 13.5L4.91 12.09L9 16.17L19.59 5.59L21 7Z'
      : 'M12 2C6.47 2 2 6.47 2 12S6.47 22 12 22 22 17.53 22 12 17.53 2 12 2M17 15.59L15.59 17L12 13.41L8.41 17L7 15.59L10.59 12L7 8.41L8.41 7L12 10.59L15.59 7L17 8.41L13.41 12L17 15.59Z';
    
    homescreenPanel.innerHTML = `
      <div class="db-connectivity-info">
        <div class="db-connectivity-icon" style="background-color: ${isOk ? 'rgba(0,210,196,0.1)' : 'rgba(244,63,94,0.1)'}; border-color: ${isOk ? 'rgba(0,210,196,0.2)' : 'rgba(244,63,94,0.2)'}; color: ${color};">
          <svg viewBox="0 0 24 24" width="20" height="20">
            <path fill="currentColor" d="${icon}"/>
          </svg>
        </div>
        <div class="db-connectivity-text">
          <h4>MyPools Homescreen</h4>
          <p>${isOk ? `Verified OK (${check.responseTime}ms) via ${check.url}` : `<span style="color: var(--color-danger); font-weight: 500;">Failed: ${check.error || 'Connection error'}</span>`}</p>
        </div>
      </div>
      <div class="db-connectivity-status" style="color: ${color}; white-space: nowrap;">
        ${isOk ? '✓ Active' : '✗ Broken'}
      </div>
    `;
  }

  if (wordpressPanel && httpConnectivity && httpConnectivity.wordpress) {
    const check = httpConnectivity.wordpress;
    const isOk = check.ok;
    const color = isOk ? 'var(--color-teal)' : 'var(--color-danger)';
    const icon = isOk
      ? 'M21 7L9 19L3.5 13.5L4.91 12.09L9 16.17L19.59 5.59L21 7Z'
      : 'M12 2C6.47 2 2 6.47 2 12S6.47 22 12 22 22 17.53 22 12 17.53 2 12 2M17 15.59L15.59 17L12 13.41L8.41 17L7 15.59L10.59 12L7 8.41L8.41 7L12 10.59L15.59 7L17 8.41L13.41 12L17 15.59Z';
    
    wordpressPanel.innerHTML = `
      <div class="db-connectivity-info">
        <div class="db-connectivity-icon" style="background-color: ${isOk ? 'rgba(0,210,196,0.1)' : 'rgba(244,63,94,0.1)'}; border-color: ${isOk ? 'rgba(0,210,196,0.2)' : 'rgba(244,63,94,0.2)'}; color: ${color};">
          <svg viewBox="0 0 24 24" width="20" height="20">
            <path fill="currentColor" d="${icon}"/>
          </svg>
        </div>
        <div class="db-connectivity-text">
          <h4>WordPress Engine</h4>
          <p>${isOk ? `Verified OK (${check.responseTime}ms) via ${check.url}` : `<span style="color: var(--color-danger); font-weight: 500;">Failed: ${check.error || 'Connection error'}</span>`}</p>
        </div>
      </div>
      <div class="db-connectivity-status" style="color: ${color}; white-space: nowrap;">
        ${isOk ? '✓ Active' : '✗ Broken'}
      </div>
    `;
  }

  const mediaThumbnailsPanel = document.getElementById('local-http-media-thumbnails');
  if (mediaThumbnailsPanel && httpConnectivity && httpConnectivity.mediaThumbnails) {
    const check = httpConnectivity.mediaThumbnails;
    const isOk = check.ok;
    const color = isOk ? 'var(--color-teal)' : 'var(--color-danger)';
    const icon = isOk
      ? 'M21 7L9 19L3.5 13.5L4.91 12.09L9 16.17L19.59 5.59L21 7Z'
      : 'M12 2C6.47 2 2 6.47 2 12S6.47 22 12 22 22 17.53 22 12 17.53 2 12 2M17 15.59L15.59 17L12 13.41L8.41 17L7 15.59L10.59 12L7 8.41L8.41 7L12 10.59L15.59 7L17 8.41L13.41 12L17 15.59Z';
    
    mediaThumbnailsPanel.innerHTML = `
      <div class="db-connectivity-info">
        <div class="db-connectivity-icon" style="background-color: ${isOk ? 'rgba(0,210,196,0.1)' : 'rgba(244,63,94,0.1)'}; border-color: ${isOk ? 'rgba(0,210,196,0.2)' : 'rgba(244,63,94,0.2)'}; color: ${color};">
          <svg viewBox="0 0 24 24" width="20" height="20">
            <path fill="currentColor" d="${icon}"/>
          </svg>
        </div>
        <div class="db-connectivity-text">
          <h4>Media &amp; Thumbnails</h4>
          <p>${isOk ? `Verified OK: ${check.message}` : `<span style="color: var(--color-danger); font-weight: 500;">Warning: ${check.message}</span>`}</p>
        </div>
      </div>
      <div class="db-connectivity-status" style="color: ${color}; white-space: nowrap;">
        ${isOk ? '✓ Active' : '✗ Warning'}
      </div>
    `;
  }
}

// --- Diagnostics & Fix Cards ---
function renderLocalDiagnostics(diagnostics, network) {
  const container = document.getElementById('local-diagnostics-container');
  if (!container) return;

  const warnings = [];

  // Check DB_HOST
  if (diagnostics.wpConfig && diagnostics.wpConfig.dbHost === 'error') {
    warnings.push({
      id: 'wp-db-host',
      title: 'Wrong DB_HOST in wp-config.local.php',
      desc: `DB_HOST is set to <code>${diagnostics.wpConfig.dbHostVal || 'localhost'}</code> — should be <code>mysql</code> (Docker Compose service name).`,
      fixType: 'wp-db-host',
      fixLabel: 'Set DB_HOST → mysql'
    });
  }

  // Check WP URLs
  if (diagnostics.wpConfig && diagnostics.wpConfig.wpUrls === 'warning') {
    warnings.push({
      id: 'wp-dynamic-urls',
      title: 'Hardcoded WP_HOME / WP_SITEURL detected',
      desc: `Value: <code>${diagnostics.wpConfig.wpUrlsVal || '(hardcoded)'}</code>. Hardcoded URLs break mobile LAN testing. Enable dynamic host resolution.`,
      fixType: 'wp-dynamic-urls',
      fixLabel: 'Enable Dynamic URLs'
    });
  }

  // Check WP Media / Thumbnails
  if (diagnostics.httpConnectivity && diagnostics.httpConnectivity.mediaThumbnails && !diagnostics.httpConnectivity.mediaThumbnails.ok) {
    const check = diagnostics.httpConnectivity.mediaThumbnails;
    warnings.push({
      id: 'wp-media-urls',
      title: 'WordPress Media & Thumbnails Issues',
      desc: `${check.message} This breaks image loading and thumbnails in the WordPress media library and front-end.`,
      fixType: 'wp-media-urls',
      fixLabel: 'Fix Media & Thumbnails'
    });
  }

  // Check Nginx upstream
  if (diagnostics.nginx && diagnostics.nginx.upstream === 'error') {
    warnings.push({
      id: 'nginx-upstream',
      title: 'Nginx Edge Upstream Misconfigured',
      desc: `proxy_pass is <code>${diagnostics.nginx.upstreamVal || '???'}</code> — should be <code>http://php:80</code> to route through Compose service.`,
      fixType: 'nginx-upstream',
      fixLabel: 'Fix Upstream → http://php:80'
    });
  }

  // Check Nginx Host Header
  if (diagnostics.nginx && diagnostics.nginx.hostHeader === 'error') {
    warnings.push({
      id: 'nginx-host-header',
      title: 'Missing proxy_set_header Host in Nginx Edge',
      desc: 'Without <code>proxy_set_header Host $http_host;</code> WordPress redirects go to the wrong origin and mobile testing breaks.',
      fixType: 'nginx-host-header',
      fixLabel: 'Add Host Header Fix'
    });
  }

  // No warnings = all clean
  if (warnings.length === 0) {
    container.innerHTML = `
      <div class="alert-box alert-success">
        <strong>✓ All diagnostics passed.</strong> DB_HOST, Nginx upstream, host header, and WP URLs all look correct.
      </div>
    `;
    return;
  }

  container.innerHTML = warnings.map(w => `
    <div class="diag-warning-card" id="diag-card-${w.id}">
      <div class="diag-warning-left">
        <div class="diag-warning-icon">
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path fill="currentColor" d="M12,2L1,21H23M12,6L19.5,19H4.5M11,10V14H13V10M11,16V18H13V16"/>
          </svg>
        </div>
        <div class="diag-warning-content">
          <h4>${w.title}</h4>
          <p>${w.desc}</p>
        </div>
      </div>
      <button class="btn btn-secondary diag-fix-btn" 
              data-fix-type="${w.fixType}" 
              data-diag-id="${w.id}"
              style="white-space:nowrap; flex-shrink:0;">
        <svg viewBox="0 0 24 24" width="14" height="14">
          <path fill="currentColor" d="M13.78 15.3L19.78 21.3L21.89 19.14L15.89 13.14L13.78 15.3M17.5 11.5C18 11.5 18.5 11.4 18.94 11.25L15.41 7.72C15.25 8.16 15.15 8.62 15.15 9.11C15.15 10.5 16.06 11.5 17.5 11.5M5.7 10.13L7.12 8.71L11.39 13L12.81 11.58L8.54 7.31L9.96 5.89L13.13 9.06L14.55 7.64L11.39 4.47C10.81 3.9 9.9 3.9 9.32 4.47L4.29 9.51C3.71 10.08 3.71 11 4.29 11.58L8.54 15.84L9.96 14.41L5.7 10.13Z"/>
        </svg>
        ${w.fixLabel}
      </button>
    </div>
  `).join('');

  // Bind fix button click handlers
  container.querySelectorAll('.diag-fix-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const fixType = btn.getAttribute('data-fix-type');
      const diagId = btn.getAttribute('data-diag-id');
      await applyLocalHealthFix(fixType, diagId, btn);
    });
  });
}

async function applyLocalHealthFix(fixType, diagId, btn) {
  const originalHTML = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner" style="width:14px;height:14px;margin:0;"></div> Applying...';

  try {
    const res = await fetch('/api/local-health/fix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: currentProject, type: fixType })
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message || 'Fix applied successfully.', 'success');
      // Refresh health data after fix
      await loadLocalHealth();
    } else {
      showToast(data.error || 'Fix failed.', 'error');
      btn.disabled = false;
      btn.innerHTML = originalHTML;
    }
  } catch (err) {
    showToast('Request failed: ' + err.message, 'error');
    btn.disabled = false;
    btn.innerHTML = originalHTML;
  }
}

// --- Paths Grid ---
function renderLocalPaths(network) {
  const grid = document.getElementById('local-paths-grid');
  if (!grid || !network) return;

  const { httpPort = '9080', edgePort = '8443', lanIp = '(unknown)', paths } = network;
  const p = paths || {};

  const pathCards = [
    {
      title: 'Host Direct HTTP',
      badge: 'HTTP · Direct',
      badgeClass: 'path-badge-direct',
      url: p.directHttp || `http://127.0.0.1:${httpPort}/wp-admin/`,
      urls: [
        { label: 'WP Admin', url: p.directHttp || `http://127.0.0.1:${httpPort}/wp-admin/` },
        { label: 'Home', url: `http://127.0.0.1:${httpPort}/` },
        { label: 'Splash', url: `http://127.0.0.1:${httpPort}/splash/` }
      ],
      note: 'Plain HTTP via Podman port mapping. No TLS.'
    },
    {
      title: 'Host HTTPS Edge',
      badge: 'HTTPS · TLS Edge',
      badgeClass: 'path-badge-edge',
      url: p.edgeHttps || `https://127.0.0.1:${edgePort}/wp-admin/`,
      urls: [
        { label: 'WP Admin', url: p.edgeHttps || `https://127.0.0.1:${edgePort}/wp-admin/` },
        { label: 'Home', url: `https://127.0.0.1:${edgePort}/` },
        { label: 'Login', url: `https://127.0.0.1:${edgePort}/wp-login.php` }
      ],
      note: 'HTTPS via local TLS edge. Matches wp-config WP_HOME.'
    },
    {
      title: 'Mobile LAN HTTP',
      badge: 'LAN · Mobile Test',
      badgeClass: 'path-badge-lan',
      url: p.lanHttp || `http://${lanIp}:${httpPort}/splash/`,
      urls: [
        { label: 'Splash', url: p.lanHttp || `http://${lanIp}:${httpPort}/splash/` },
        { label: 'Home', url: `http://${lanIp}:${httpPort}/` },
        { label: 'WP Admin', url: `http://${lanIp}:${httpPort}/wp-admin/` }
      ],
      note: `Your LAN IP: ${lanIp}. Use on any device on same WiFi.`
    },
    {
      title: 'Mobile LAN HTTPS',
      badge: 'LAN · TLS Edge',
      badgeClass: 'path-badge-lan',
      url: p.lanHttps || `https://${lanIp}:${edgePort}/splash/`,
      urls: [
        { label: 'Splash', url: p.lanHttps || `https://${lanIp}:${edgePort}/splash/` },
        { label: 'Home', url: `https://${lanIp}:${edgePort}/` },
        { label: 'WP Admin', url: `https://${lanIp}:${edgePort}/wp-admin/` }
      ],
      note: `HTTPS via edge TLS. Browser may warn about self-signed cert.`
    }
  ];

  grid.innerHTML = pathCards.map(card => `
    <div class="card path-card">
      <div class="path-card-header">
        <span class="path-card-title">${card.title}</span>
        <span class="path-card-badge ${card.badgeClass}">${card.badge}</span>
      </div>
      <p style="font-size:12px; color:var(--text-desc); margin: 0;">${card.note}</p>
      ${card.urls.map(u => `
        <div class="path-card-url-box">
          <a href="${u.url}" target="_blank" rel="noopener noreferrer" class="path-card-url" title="${u.url}" style="text-decoration:none; color:inherit; flex:1;">
            ${u.url}
          </a>
          <button class="btn-text-primary" style="padding:3px 6px; font-size:11px; flex-shrink:0;" 
                  onclick="navigator.clipboard.writeText('${u.url}').then(()=>showToast('Copied!','success')).catch(()=>{})" 
                  title="Copy URL">
            <svg viewBox="0 0 24 24" width="13" height="13">
              <path fill="currentColor" d="M19 3H5C3.9 3 3 3.9 3 5V19C3 20.1 3.9 21 5 21H19C20.1 21 21 20.1 21 19V5C21 3.9 20.1 3 19 3M19 19H5V5H19V19M9 7H7V9H9V7M9 11H7V13H9V11M9 15H7V17H9V15M17 7H11V9H17V7M17 11H11V13H17V11M17 15H11V17H17V15Z"/>
            </svg>
          </button>
        </div>
      `).join('')}
    </div>
  `).join('');
}

// --- Config Backup History ---
function renderLocalBackups(backups) {
  const container = document.getElementById('local-backups-container');
  if (!container) return;

  if (!backups || backups.length === 0) {
    container.innerHTML = `
      <div class="alert-box alert-info">
        <strong>No backups yet.</strong> Config files are watched automatically. Backups appear here when files change.
      </div>
    `;
    return;
  }

  // Group backups by file identity (prefix before timestamp)
  const grouped = {};
  backups.forEach(b => {
    // filename pattern: fileId_timestamp.bak
    const parts = b.filename.split('_');
    // The timestamp is the last numeric-like segment before .bak
    const tsIdx = parts.findLastIndex(p => /^\d{4}/.test(p));
    const fileKey = tsIdx >= 0 ? parts.slice(0, tsIdx).join('_') : b.filename;
    if (!grouped[fileKey]) grouped[fileKey] = [];
    grouped[fileKey].push(b);
  });

  const allItems = backups.slice(0, 30); // Show last 30 backups across all files

  container.innerHTML = allItems.map((backup, idx) => {
    const dt = new Date(backup.mtime);
    const relTime = getRelativeTime(backup.mtime);
    const absTime = dt.toLocaleString();
    const sizeKb = (backup.size / 1024).toFixed(1);

    // Derive the original file path from filename
    const friendlyName = backup.filename
      .replace(/^secrets_/, 'secrets/')
      .replace(/^nginx_edge_conf\.d_/, 'nginx/edge/conf.d/')
      .replace(/^nginx_conf\.d_/, 'nginx/conf.d/')
      .replace(/_\d{8}_\d{6}\.bak$/, '')
      .replace(/_/g, '/');

    return `
      <div class="backup-timeline-item" id="backup-item-${idx}">
        <div class="backup-item-header">
          <div class="backup-item-info">
            <div class="backup-icon-wrapper">
              <svg viewBox="0 0 24 24" width="16" height="16">
                <path fill="currentColor" d="M14 2H6C4.9 2 4 2.9 4 4V20C4 21.1 4.9 22 6 22H18C19.1 22 20 21.1 20 20V8L14 2M18 20H6V4H13V9H18V20M10 13H12V17H10V13M10 9H12V11H10V9Z"/>
              </svg>
            </div>
            <div class="backup-meta">
              <h5>${friendlyName}</h5>
              <p>
                <span title="${absTime}">${relTime}</span>
                <span>· ${absTime}</span>
                <span>· ${sizeKb} KB</span>
              </p>
            </div>
          </div>
          <div class="backup-item-actions">
            <button class="btn btn-secondary" style="padding:6px 10px; font-size:12px;"
                    onclick="toggleBackupDiff(${idx}, '${backup.filename}')" 
                    title="Preview file contents">
              <svg viewBox="0 0 24 24" width="14" height="14">
                <path fill="currentColor" d="M12 4.5C7 4.5 2.7 7.6 1 12C2.7 16.4 7 19.5 12 19.5S21.3 16.4 23 12C21.3 7.6 17 4.5 12 4.5M12 17C9.2 17 7 14.8 7 12S9.2 7 12 7 17 9.2 17 12 14.8 17 12 17M12 9C10.3 9 9 10.3 9 12S10.3 15 12 15 15 13.7 15 12 13.7 9 12 9Z"/>
              </svg>
              Preview
            </button>
            <button class="btn btn-danger" style="padding:6px 10px; font-size:12px;"
                    onclick="restoreLocalBackup('${backup.filename}')"
                    title="Restore this config backup to its original location">
              <svg viewBox="0 0 24 24" width="14" height="14">
                <path fill="currentColor" d="M12 5V1L7 6L12 11V7C15.3 7 18 9.7 18 13S15.3 19 12 19 6 16.3 6 13H4C4 17.4 7.6 21 12 21S20 17.4 20 13 16.4 5 12 5Z"/>
              </svg>
              Restore
            </button>
          </div>
        </div>
        <div class="diff-preview-box" id="diff-preview-${idx}" style="display:none;">
          <pre style="color:var(--text-muted); font-size:11px;">Loading preview...</pre>
        </div>
      </div>
    `;
  }).join('');
}

async function toggleBackupDiff(idx, filename) {
  const previewBox = document.getElementById(`diff-preview-${idx}`);
  if (!previewBox) return;

  if (previewBox.style.display !== 'none') {
    previewBox.style.display = 'none';
    return;
  }

  previewBox.style.display = 'block';
  previewBox.innerHTML = '<pre style="color:var(--text-muted); font-size:11px;">Loading preview...</pre>';

  try {
    const res = await fetch(`/api/local-health/backups?project=${currentProject}&filename=${encodeURIComponent(filename)}`);
    if (!res.ok) throw new Error('Failed to fetch backup');
    const data = await res.json();
    previewBox.innerHTML = `<pre>${escapeHtml(data.content || '(empty file)')}</pre>`;
  } catch (err) {
    previewBox.innerHTML = `<pre style="color:var(--color-danger);">Error loading backup: ${err.message}</pre>`;
  }
}

async function restoreLocalBackup(filename) {
  if (!confirm(`Restore "${filename}" to its original path? This will overwrite the current file.`)) return;

  try {
    const res = await fetch('/api/local-health/backups/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: currentProject, filename })
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message || 'File restored successfully.', 'success');
      await loadLocalHealth();
    } else {
      showToast(data.error || 'Restore failed.', 'error');
    }
  } catch (err) {
    showToast('Request failed: ' + err.message, 'error');
  }
}

// --- Restart Stack Button ---
document.addEventListener('DOMContentLoaded', () => {
  const restartBtn = document.getElementById('local-restart-stack-btn');
  if (restartBtn) {
    restartBtn.addEventListener('click', async () => {
      if (!currentProject) {
        showToast('No project selected.', 'warning');
        return;
      }
      if (!confirm('This will run podman compose down + up for the current project. Continue?')) return;

      restartBtn.disabled = true;
      restartBtn.innerHTML = '<div class="spinner" style="width:14px;height:14px;margin:0 8px 0 0;"></div> Restarting...';

      try {
        const res = await fetch('/api/local-health/fix', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: currentProject, type: 'restart-stack' })
        });
        const data = await res.json();
        if (data.success) {
          showToast('Stack restarted successfully.', 'success');
        } else {
          showToast(data.error || 'Restart failed.', 'error');
        }
      } catch (err) {
        showToast('Request failed: ' + err.message, 'error');
      } finally {
        restartBtn.disabled = false;
        restartBtn.innerHTML = `
          <svg viewBox="0 0 24 24" width="16" height="16">
            <path fill="currentColor" d="M12,4V1L8,5L12,9V6A6,6 0 0,1 18,12A6,6 0 0,1 12,18A6,6 0 0,1 6,12H4A8,8 0 0,0 12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4Z"/>
          </svg>
          Restart Compose Stack
        `;
      }
    });
  }
});

function formatServerUptime(seconds) {
  const total = Math.floor(seconds || 0);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m ${total % 60}s`;
}

async function loadServerStatus() {
  const statusDot = document.getElementById('essop-server-status-dot');
  const statusText = document.getElementById('essop-server-status-text');
  const pidEl = document.getElementById('essop-server-pid');
  const uptimeEl = document.getElementById('essop-server-uptime');
  const endpointEl = document.getElementById('essop-server-endpoint');

  try {
    const res = await fetch('/api/server/status', { cache: 'no-cache' });
    if (!res.ok) throw new Error('Status unavailable');
    const data = await res.json();

    if (statusDot) statusDot.className = 'status-dot dot-running';
    if (statusText) statusText.textContent = 'Online';
    if (pidEl) pidEl.textContent = String(data.pid || '—');
    if (uptimeEl) uptimeEl.textContent = formatServerUptime(data.uptime);
    if (endpointEl) endpointEl.textContent = `http://localhost:${data.port || 3050}`;
  } catch (err) {
    if (statusDot) statusDot.className = 'status-dot';
    if (statusText) statusText.textContent = 'Unreachable';
    if (pidEl) pidEl.textContent = '—';
    if (uptimeEl) uptimeEl.textContent = '—';
    if (endpointEl) endpointEl.textContent = '—';
  }
}

function getRestartServerButtonHtml() {
  return '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12,4V1L8,5L12,9V6A6,6 0 0,1 18,12A6,6 0 0,1 12,18A6,6 0 0,1 6,12H4A8,8 0 0,0 12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4Z"/></svg> Restart Server';
}

async function restartEssopServer(restartServerBtn) {
  if (!confirm('Restart the ESSOP web server? The page will reconnect automatically after the server comes back online.')) return;

  restartServerBtn.disabled = true;
  restartServerBtn.innerHTML = '<div class="spinner" style="width:14px;height:14px;margin:0 8px 0 0;"></div> Restarting...';

  const statusText = document.getElementById('essop-server-status-text');
  const statusDot = document.getElementById('essop-server-status-dot');
  if (statusText) statusText.textContent = 'Restarting...';
  if (statusDot) statusDot.className = 'status-dot';

  const pollForServer = () => {
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      try {
        const check = await fetch('/api/server/status', { cache: 'no-cache' });
        if (check.ok) {
          clearInterval(poll);
          window.location.reload();
          return;
        }
      } catch (e) {
        // Server not up yet
      }
      if (attempts >= 60) {
        clearInterval(poll);
        showToast('Server did not come back online within 60 seconds.', 'error');
        restartServerBtn.disabled = false;
        restartServerBtn.innerHTML = getRestartServerButtonHtml();
        loadServerStatus();
      }
    }, 1000);
  };

  try {
    const res = await fetch('/api/server/restart', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('Server restarting — page will reload when ready.', 'success');
      pollForServer();
    } else {
      showToast(data.error || 'Server restart failed.', 'error');
      restartServerBtn.disabled = false;
      restartServerBtn.innerHTML = getRestartServerButtonHtml();
      loadServerStatus();
    }
  } catch (err) {
    showToast('Server is restarting — waiting for it to come back...', 'info');
    pollForServer();
  }
}

// --- Restart ESSOP Server Button ---
document.addEventListener('DOMContentLoaded', () => {
  const restartServerBtn = document.getElementById('restart-essop-server-btn');
  if (restartServerBtn) {
    restartServerBtn.addEventListener('click', () => restartEssopServer(restartServerBtn));
    loadServerStatus();
  }
});

// Helper: escape HTML for preview
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
