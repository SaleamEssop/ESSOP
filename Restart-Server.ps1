#Requires -Version 5.1
param(
    [Parameter(Mandatory = $true)]
    [int]$ParentPid,

    [Parameter(Mandatory = $true)]
    [string]$NodeExe,

    [Parameter(Mandatory = $true)]
    [string]$Root
)

Start-Sleep -Seconds 2
Stop-Process -Id $ParentPid -Force -ErrorAction SilentlyContinue
Start-Process -FilePath $NodeExe -ArgumentList 'server.js' -WorkingDirectory $Root -WindowStyle Hidden | Out-Null
