# Implementation Plan: Dynamic Multi-Project Console & Snapshot-Enforced Deployments

We will transform the Snapshot Recovery Console into a generic, multi-server dashboard. Users can add arbitrary, self-contained project folders (such as `C:\ESSOP` or `C:\Podman\MyPools`) to the console. Each project will store its snapshots and credentials within its own directory, and we will restrict Git deployments to only run from completed snapshots to enforce intent.

---

## User Review Required

> [!IMPORTANT]
> - **Self-Contained Storage**: Snapshots will move from `C:\snapshots\<ProjectName>` to `[ProjectFolder]\.snapshots\`. Project settings and SSH secrets will live in `[ProjectFolder]\.local\settings.json` and `[ProjectFolder]\.local\ssh.secret.txt` respectively.
> - **Git Ignore Integration**: The console will automatically append `.snapshots/` and `.local/` to the project's `.gitignore` file to ensure backups and secrets are never committed.
> - **Mandatory Snapshot Deployments**: We will enforce that Git deployments must select a snapshot. The "Current Local Workspace" option will be removed from the Git Deployment tab.
> - **Dynamic Folder Management**: A text input and button will be added to the UI header to register new project folder paths on the system.

---

## Proposed Changes

### 1. Backend Core & APIs
#### [server.js](file:///C:/ESSOP/server.js)
- Read and manage the list of active project folders from a persistent configuration file at [projects.json](file:///C:/ESSOP/projects.json).
- Initialize `projects.json` with the default `mypools` path (`C:\Podman\MyPools`) if it does not exist.
- Add `POST /api/projects/add` endpoint:
  - Takes `{ path: "C:\\ESSOP" }`.
  - Resolves path, checks if directory exists, derives the name from the folder base (e.g. `ESSOP`), and saves it to `projects.json`.
- Add `DELETE /api/projects` endpoint:
  - Removes a project folder mapping from `projects.json` (does not touch files on disk).
- Update `GET /api/projects` to return the array of registered projects from `projects.json`.
- Update snapshot, restore, and deploy APIs to load settings, SSH passwords, and container details relative to the selected project's path.
- Pass `-SourcePath [path]` dynamically to PowerShell scripts.
- Enforce that `POST /api/git/deploy` rejects requests if `snapshotName` is missing or equal to `current-local`.

### 2. Automation Scripts
#### [Refresh-Registry.ps1](file:///C:/ESSOP/Refresh-Registry.ps1)
- Read `C:\ESSOP\projects.json`.
- Loop through the registered projects and read snapshots from `[ProjectFolder]\.snapshots\`.
- Maintain backward compatibility by falling back to scan `C:\ESSOP\*` if `projects.json` is missing.

#### [Create-Snapshot.ps1](file:///C:/ESSOP/Create-Snapshot.ps1)
- Require `-SourcePath`.
- Write snapshots directly to `$Source\.snapshots\$timestamp\`.
- Save the latest snapshot pointer in `$Source\.snapshots\active.txt`.
- Append `.snapshots/` and `.local/` to `$Source\.gitignore` if not already present.

#### [Restore-Snapshot.ps1](file:///C:/ESSOP/Restore-Snapshot.ps1)
- Resolve snapshots from `$Source\.snapshots\$SnapshotName\`.
- Extract zip and dump SQL relative to the project directory `$Source`.

#### [Deploy-Git.ps1](file:///C:/ESSOP/Deploy-Git.ps1)
- Accept `-SourcePath` parameter.
- Make `-SnapshotName` parameter **Mandatory**.
- Set local repository root to `-SourcePath`.
- Resolve SSH credentials and tools (like `plink.exe`) using project-specific local directories or global fallbacks under `C:\ESSOP\tools\`.

### 3. Frontend Layout & Logic
#### [index.html](file:///C:/ESSOP/public/index.html)
- Add a project management button and modal or inline input in the header sidebar: "Add Project Folder".
- Remove "Current Local Workspace" default option from the Git Deploy snapshot dropdown.
- Add a project removal button next to the project dropdown selector to unregister folders.

#### [app.js](file:///C:/ESSOP/public/app.js)
- Bind inputs and action handlers for registering new project directories.
- Ensure all API triggers pass the active project configuration.
- Enforce validation on the Git Deployment form: disable the "Deploy to Production" button if no snapshot is selected.

---

## Verification Plan

### Automated / API Checks
- Run script and API sanity tests using Node CLI scripts or cURL to verify:
  - `POST /api/projects/add` registers `C:\ESSOP` and updates `projects.json`.
  - `GET /api/snapshots?project=ESSOP` resolves list from `C:\ESSOP\.snapshots`.
  - `POST /api/git/deploy` throws 400 error when attempting to deploy without a snapshot parameter.

### Manual Verification
- Add `C:\ESSOP` as a new project in the browser UI.
- Create a test snapshot and check that it is written to `C:\ESSOP\.snapshots`.
- Verify that `.snapshots` and `.local` are automatically added to `C:\ESSOP\.gitignore`.
- Confirm that the Git Deployment panel dropdown only offers snapshot versions and that selecting a snapshot deploys successfully.
