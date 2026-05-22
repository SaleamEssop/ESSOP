#Requires -Version 5.1
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$SnapshotsRoot = "C:\snapshots"
$script:ActiveProject = "mypools"
$script:Snapshots = @()
$script:IsBusy = $false

$BgColor    = [System.Drawing.Color]::FromArgb(15, 25, 35)
$CardColor  = [System.Drawing.Color]::FromArgb(21, 34, 40)
$Accent     = [System.Drawing.Color]::FromArgb(13, 148, 136)
$Danger     = [System.Drawing.Color]::FromArgb(220, 38, 38)
$TextColor  = [System.Drawing.Color]::FromArgb(224, 224, 224)
$MutedColor = [System.Drawing.Color]::FromArgb(122, 139, 160)
$BorderColor= [System.Drawing.Color]::FromArgb(30, 58, 80)
$InputBg    = [System.Drawing.Color]::FromArgb(26, 42, 58)

$form = New-Object System.Windows.Forms.Form
$form.Text = "MyPools - Snapshot Recovery"
$form.Size = New-Object System.Drawing.Size(840, 620)
$form.StartPosition = "CenterScreen"
$form.BackColor = $BgColor
$form.ForeColor = $TextColor
$form.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$form.MinimumSize = New-Object System.Drawing.Size(700, 500)

$header = New-Object System.Windows.Forms.Label
$header.Text = "MyPools - Snapshot Recovery"
$header.Font = New-Object System.Drawing.Font("Segoe UI", 14, [System.Drawing.FontStyle]::Bold)
$header.ForeColor = [System.Drawing.Color]::White
$header.Size = New-Object System.Drawing.Size(800, 30)
$header.Location = New-Object System.Drawing.Point(20, 15)

$subtitle = New-Object System.Windows.Forms.Label
$subtitle.Text = "Snapshots at C:\snapshots\  (external - survives project loss)"
$subtitle.ForeColor = $MutedColor
$subtitle.Size = New-Object System.Drawing.Size(800, 20)
$subtitle.Location = New-Object System.Drawing.Point(20, 45)

$tabY = 75
$projectLabel = New-Object System.Windows.Forms.Label
$projectLabel.Text = "Project:"
$projectLabel.ForeColor = $MutedColor
$projectLabel.Size = New-Object System.Drawing.Size(55, 25)
$projectLabel.Location = New-Object System.Drawing.Point(20, ($tabY + 5))

$projectCombo = New-Object System.Windows.Forms.ComboBox
$projectCombo.Size = New-Object System.Drawing.Size(150, 28)
$projectCombo.Location = New-Object System.Drawing.Point(75, $tabY)
$projectCombo.BackColor = $InputBg
$projectCombo.ForeColor = $TextColor
$projectCombo.FlatStyle = "Flat"
$projectCombo.DropDownStyle = "DropDownList"

$toolbarY = ($tabY + 40)
$descLabel = New-Object System.Windows.Forms.Label
$descLabel.Text = "Description:"
$descLabel.ForeColor = $MutedColor
$descLabel.Size = New-Object System.Drawing.Size(70, 25)
$descLabel.Location = New-Object System.Drawing.Point(20, ($toolbarY + 5))

$descInput = New-Object System.Windows.Forms.TextBox
$descInput.Size = New-Object System.Drawing.Size(280, 26)
$descInput.Location = New-Object System.Drawing.Point(92, $toolbarY)
$descInput.BackColor = $InputBg
$descInput.ForeColor = $TextColor
$descInput.BorderStyle = "FixedSingle"
$descInput.Text = "Manual snapshot"

$liveCheck = New-Object System.Windows.Forms.CheckBox
$liveCheck.Text = "Live"
$liveCheck.Size = New-Object System.Drawing.Size(55, 24)
$liveCheck.Location = New-Object System.Drawing.Point(385, ($toolbarY + 2))
$liveCheck.BackColor = $BgColor
$liveCheck.ForeColor = $MutedColor
$liveCheck.FlatStyle = "Flat"

$noDbCheck = New-Object System.Windows.Forms.CheckBox
$noDbCheck.Text = "No DB"
$noDbCheck.Size = New-Object System.Drawing.Size(65, 24)
$noDbCheck.Location = New-Object System.Drawing.Point(445, ($toolbarY + 2))
$noDbCheck.BackColor = $BgColor
$noDbCheck.ForeColor = $MutedColor
$noDbCheck.FlatStyle = "Flat"

$createBtn = New-Object System.Windows.Forms.Button
$createBtn.Text = "Create Snapshot"
$createBtn.Size = New-Object System.Drawing.Size(130, 28)
$createBtn.Location = New-Object System.Drawing.Point(520, $toolbarY)
$createBtn.BackColor = $Accent
$createBtn.ForeColor = [System.Drawing.Color]::White
$createBtn.FlatStyle = "Flat"
$createBtn.FlatAppearance.BorderSize = 0
$createBtn.Cursor = "Hand"

$refreshBtn = New-Object System.Windows.Forms.Button
$refreshBtn.Text = "Refresh"
$refreshBtn.Size = New-Object System.Drawing.Size(80, 28)
$refreshBtn.Location = New-Object System.Drawing.Point(660, $toolbarY)
$refreshBtn.BackColor = $BorderColor
$refreshBtn.ForeColor = [System.Drawing.Color]::FromArgb(192, 208, 224)
$refreshBtn.FlatStyle = "Flat"
$refreshBtn.FlatAppearance.BorderSize = 0
$refreshBtn.Cursor = "Hand"

$sep1 = New-Object System.Windows.Forms.Label
$sep1.Size = New-Object System.Drawing.Size(800, 1)
$sep1.Location = New-Object System.Drawing.Point(20, ($toolbarY + 38))
$sep1.BackColor = $BorderColor
$sep1.Text = ""

$gridY = ($toolbarY + 55)
$grid = New-Object System.Windows.Forms.DataGridView
$grid.Size = New-Object System.Drawing.Size(795, 340)
$grid.Location = New-Object System.Drawing.Point(20, $gridY)
$grid.BackgroundColor = $CardColor
$grid.BorderStyle = "None"
$grid.RowHeadersVisible = $false
$grid.AllowUserToAddRows = $false
$grid.AllowUserToDeleteRows = $false
$grid.AllowUserToResizeRows = $false
$grid.ReadOnly = $true
$grid.SelectionMode = "FullRowSelect"
$grid.AutoSizeColumnsMode = "Fill"
$grid.EnableHeadersVisualStyles = $false
$grid.ColumnHeadersDefaultCellStyle.BackColor = [System.Drawing.Color]::FromArgb(13, 21, 30)
$grid.ColumnHeadersDefaultCellStyle.ForeColor = $MutedColor
$grid.ColumnHeadersDefaultCellStyle.Font = New-Object System.Drawing.Font("Segoe UI", 8.5, [System.Drawing.FontStyle]::Bold)
$grid.ColumnHeadersHeight = 32
$grid.ColumnHeadersBorderStyle = "None"
$grid.DefaultCellStyle.BackColor = $CardColor
$grid.DefaultCellStyle.ForeColor = $TextColor
$grid.DefaultCellStyle.SelectionBackColor = [System.Drawing.Color]::FromArgb(13, 148, 136, 60)
$grid.DefaultCellStyle.SelectionForeColor = [System.Drawing.Color]::White
$grid.DefaultCellStyle.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$grid.RowTemplate.Height = 36
$grid.GridColor = $BorderColor
$grid.CellBorderStyle = "SingleHorizontal"

$colDate = New-Object System.Windows.Forms.DataGridViewTextBoxColumn
$colDate.Name = "Date"; $colDate.HeaderText = "Date"; $colDate.FillWeight = 20
$colDesc = New-Object System.Windows.Forms.DataGridViewTextBoxColumn
$colDesc.Name = "Description"; $colDesc.HeaderText = "Description"; $colDesc.FillWeight = 40
$colType = New-Object System.Windows.Forms.DataGridViewTextBoxColumn
$colType.Name = "Type"; $colType.HeaderText = "Type"; $colType.FillWeight = 12
$colDB = New-Object System.Windows.Forms.DataGridViewTextBoxColumn
$colDB.Name = "DB"; $colDB.HeaderText = "DB"; $colDB.FillWeight = 8
$colFiles = New-Object System.Windows.Forms.DataGridViewTextBoxColumn
$colFiles.Name = "Files"; $colFiles.HeaderText = "Files"; $colFiles.FillWeight = 10
$colGit = New-Object System.Windows.Forms.DataGridViewTextBoxColumn
$colGit.Name = "Git"; $colGit.HeaderText = "Git"; $colGit.FillWeight = 10
[void]$grid.Columns.Add($colDate)
[void]$grid.Columns.Add($colDesc)
[void]$grid.Columns.Add($colType)
[void]$grid.Columns.Add($colDB)
[void]$grid.Columns.Add($colFiles)
[void]$grid.Columns.Add($colGit)

$btnY = ($gridY + 355)
$restoreBtn = New-Object System.Windows.Forms.Button
$restoreBtn.Text = "Restore Selected"
$restoreBtn.Size = New-Object System.Drawing.Size(140, 32)
$restoreBtn.Location = New-Object System.Drawing.Point(20, $btnY)
$restoreBtn.BackColor = $Accent
$restoreBtn.ForeColor = [System.Drawing.Color]::White
$restoreBtn.FlatStyle = "Flat"
$restoreBtn.FlatAppearance.BorderSize = 0
$restoreBtn.Cursor = "Hand"
$restoreBtn.Enabled = $false

$deleteBtn = New-Object System.Windows.Forms.Button
$deleteBtn.Text = "Delete Selected"
$deleteBtn.Size = New-Object System.Drawing.Size(140, 32)
$deleteBtn.Location = New-Object System.Drawing.Point(170, $btnY)
$deleteBtn.BackColor = $Danger
$deleteBtn.ForeColor = [System.Drawing.Color]::White
$deleteBtn.FlatStyle = "Flat"
$deleteBtn.FlatAppearance.BorderSize = 0
$deleteBtn.Cursor = "Hand"
$deleteBtn.Enabled = $false

$statusBar = New-Object System.Windows.Forms.Label
$statusBar.Text = "Ready."
$statusBar.ForeColor = $MutedColor
$statusBar.Size = New-Object System.Drawing.Size(780, 25)
$statusBar.Location = New-Object System.Drawing.Point(20, ($btnY + 42))
function LoadProjects {
  $projectCombo.Items.Clear()
  if (Test-Path $SnapshotsRoot) {
    Get-ChildItem -Path $SnapshotsRoot -Directory -ErrorAction SilentlyContinue | Where-Object {
      $_.Name -notmatch "^(templates|_archive)$" -and (Test-Path (Join-Path $_.FullName "active.txt"))
    } | ForEach-Object { [void]$projectCombo.Items.Add($_.Name) }
  }
  if ($projectCombo.Items.Count -eq 0) { [void]$projectCombo.Items.Add("mypools") }
  $projectCombo.SelectedIndex = 0
}

function LoadSnapshots {
  if ($script:IsBusy) { return }
  $script:IsBusy = $true
  $dataFile = Join-Path $SnapshotsRoot "snapshots-data.js"
  $refreshScript = Join-Path $SnapshotsRoot "Refresh-Registry.ps1"
  try {
    & $refreshScript 2>$null | Out-Null
    if (-not (Test-Path $dataFile)) { $grid.Rows.Clear(); $script:Snapshots = @(); $statusBar.Text = "$script:ActiveProject - no snapshots"; $script:IsBusy = $false; return }
    $raw = Get-Content $dataFile -Raw
    $idx = $raw.IndexOf("__SNAPSHOT_REGISTRY__")
    if ($idx -lt 0) { $grid.Rows.Clear(); $script:Snapshots = @(); $statusBar.Text = "$script:ActiveProject - no snapshots"; $script:IsBusy = $false; return }
    $jsCode = $raw.Substring($idx)
    $jsonStart = $jsCode.IndexOf("=") + 1
    $jsonEnd = $jsCode.LastIndexOf(";")
    if ($jsonStart -le 0 -or $jsonEnd -le 0) { $grid.Rows.Clear(); $script:Snapshots = @(); $statusBar.Text = "Registry parse error"; $script:IsBusy = $false; return }
    $json = $jsCode.Substring($jsonStart, $jsonEnd - $jsonStart).Trim()
    $registry = $json | ConvertFrom-Json
    $proj = $registry.$script:ActiveProject
    if (-not $proj -or -not $proj.snapshots) { $grid.Rows.Clear(); $script:Snapshots = @(); $statusBar.Text = "$script:ActiveProject - no snapshots"; $script:IsBusy = $false; return }
    $script:Snapshots = @($proj.snapshots)
    $grid.Rows.Clear()
    foreach ($snap in $script:Snapshots) {
      $ts = if ($snap.timestamp) { try { ([DateTime]$snap.timestamp).ToString("yyyy-MM-dd HH:mm") } catch { $snap.name } } else { $snap.name }
      $typeText = if ($snap.powered_off) { "Consistent" } else { "Live" }
      $dbText = if ($snap.database_included) { "Yes" } else { "No" }
      $filesText = if ($snap.files_count) { "{0:N0}" -f $snap.files_count } else { "-" }
      $gitText = if ($snap.git_commit) { "$($snap.git_branch)@$($snap.git_commit)" } else { "-" }
      [void]$grid.Rows.Add($ts, $snap.description, $typeText, $dbText, $filesText, $gitText)
    }
    if ($grid.Rows.Count -gt 0) {
      $grid.Rows[0].DefaultCellStyle.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
      $grid.Rows[0].DefaultCellStyle.ForeColor = [System.Drawing.Color]::FromArgb(13, 255, 200)
    }
    $statusBar.Text = "$script:ActiveProject - $($script:Snapshots.Count) snapshot(s)"
  } catch { $statusBar.Text = "Error: $($_.Exception.Message)" }
  finally { $script:IsBusy = $false }
}

function CreateSnapshot {
  if ($script:IsBusy) { return }
  $desc = $descInput.Text.Trim()
  if (-not $desc) { $desc = "Manual snapshot $(Get-Date -Format 'yyyy-MM-dd HH:mm')" }
  $noDb = if ($noDbCheck.Checked) { " -NoDatabase" } else { "" }
  $live = if ($liveCheck.Checked) { " -Live" } else { "" }
  $script:IsBusy = $true; $createBtn.Enabled = $false
  $statusBar.Text = "Creating snapshot..."; $form.Refresh()
  $script = Join-Path $SnapshotsRoot "Create-Snapshot.ps1"
  try {
    $cmd = "powershell -NoProfile -NonInteractive -File `"$script`" -Project $script:ActiveProject -Description '$($desc -replace "'", "''")'$noDb$live"
    Invoke-Expression $cmd 2>&1 | Out-Null
    $descInput.Text = ""
    LoadSnapshots
    $statusBar.Text = "Snapshot created: $desc"
  } catch { $statusBar.Text = "Error: $($_.Exception.Message)" }
  finally { $script:IsBusy = $false; $createBtn.Enabled = $true }
}

function RestoreSelected {
  if ($script:IsBusy) { return }
  if ($grid.SelectedRows.Count -eq 0) { return }
  $idx = $grid.SelectedRows[0].Index
  if ($idx -lt 0 -or $idx -ge $script:Snapshots.Count) { return }
  $snap = $script:Snapshots[$idx]; $name = $snap.name
  $result = [System.Windows.Forms.MessageBox]::Show(
    "Restore from snapshot:`n`n  $name`n  $($snap.description)`n`nThis will OVERWRITE the current project.`nA pre-restore safety backup will be created.`n`nContinue?",
    "Confirm Restore",
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Warning
  )
  if ($result -ne "Yes") { return }
  $script:IsBusy = $true; $statusBar.Text = "Restoring from $name..."; $form.Refresh()
  $script = Join-Path $SnapshotsRoot "Restore-Snapshot.ps1"
  try {
    $cmd = "powershell -NoProfile -NonInteractive -File `"$script`" -Project $script:ActiveProject -SnapshotName $name -SkipPreBackup"
    Invoke-Expression $cmd 2>&1 | Out-Null
    LoadSnapshots
    $statusBar.Text = "Restored from: $name"
  } catch { $statusBar.Text = "Error: $($_.Exception.Message)" }
  finally { $script:IsBusy = $false }
}

function DeleteSelected {
  if ($script:IsBusy) { return }
  if ($grid.SelectedRows.Count -eq 0) { return }
  $idx = $grid.SelectedRows[0].Index
  if ($idx -lt 0 -or $idx -ge $script:Snapshots.Count) { return }
  $snap = $script:Snapshots[$idx]; $name = $snap.name
  $result = [System.Windows.Forms.MessageBox]::Show(
    "Permanently delete snapshot:`n`n  $name`n  $($snap.description)`n`nThis cannot be undone.",
    "Confirm Delete",
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Warning
  )
  if ($result -ne "Yes") { return }
  $script:IsBusy = $true; $statusBar.Text = "Deleting $name..."; $form.Refresh()
  $targetDir = Join-Path $SnapshotsRoot "$script:ActiveProject\$name"
  try {
    if (Test-Path $targetDir) { Remove-Item -Recurse -Force $targetDir }
    $refreshScript = Join-Path $SnapshotsRoot "Refresh-Registry.ps1"
    & $refreshScript 2>$null | Out-Null
    LoadSnapshots
    $statusBar.Text = "Deleted: $name"
  } catch { $statusBar.Text = "Error: $($_.Exception.Message)" }
  finally { $script:IsBusy = $false }
}


$createBtn.Add_Click({ CreateSnapshot })
$refreshBtn.Add_Click({ LoadSnapshots })
$restoreBtn.Add_Click({ RestoreSelected })
$deleteBtn.Add_Click({ DeleteSelected })

$projectCombo.Add_SelectedIndexChanged({
  $script:ActiveProject = $projectCombo.SelectedItem.ToString()
  LoadSnapshots
})

$grid.Add_SelectionChanged({
  $hasSel = $grid.SelectedRows.Count -gt 0
  $restoreBtn.Enabled = $hasSel
  $deleteBtn.Enabled = $hasSel
})

$descInput.Add_KeyDown({
  if ($_.KeyCode -eq "Enter") { CreateSnapshot }
})

$form.Add_Shown({
  $form.Activate()
  LoadProjects
  LoadSnapshots
  $descInput.Focus()
})

$form.Controls.AddRange(@(
  $header, $subtitle,
  $projectLabel, $projectCombo,
  $descLabel, $descInput, $liveCheck, $noDbCheck, $createBtn, $refreshBtn,
  $sep1,
  $grid,
  $restoreBtn, $deleteBtn,
  $statusBar
))

$form.ShowDialog() | Out-Null
