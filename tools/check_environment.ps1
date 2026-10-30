<#
.SYNOPSIS
    Inspects host environment for UpdatePilot prerequisites (Read-Only).

.DESCRIPTION
    Outputs:
    - Windows version and build
    - PowerShell version
    - WinGet presence and version
    - Python presence and version
    - Administrator privilege status
    This script strictly queries information and makes zero modifications.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'SilentlyContinue'

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "             UpdatePilot Environment Inspector              " -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

# 1. Administrator Check
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$adminStatus = if ($isAdmin) { "Yes (Elevated)" } else { "No (Standard User)" }
$adminColor = if ($isAdmin) { "Green" } else { "Yellow" }
Write-Host "Running as Administrator : " -NoNewline
Write-Host $adminStatus -ForegroundColor $adminColor

# 2. Windows Version
try {
    $os = Get-CimInstance Win32_OperatingSystem
    $osInfo = "$($os.Caption) (Version: $($os.Version), Build: $($os.BuildNumber))"
} catch {
    $osInfo = [System.Environment]::OSVersion.VersionString
}
Write-Host "Windows Version          : $osInfo"

# 3. PowerShell Version
$psVersion = $PSVersionTable.PSVersion.ToString()
Write-Host "PowerShell Version       : $psVersion"

# 4. WinGet Check
$wingetCmd = Get-Command winget -ErrorAction SilentlyContinue
if ($wingetCmd) {
    try {
        $rawWingetVer = & winget --version
        $wingetVer = ($rawWingetVer | Out-String).Trim()
        Write-Host "WinGet Installed         : " -NoNewline
        Write-Host "Yes ($wingetVer) [$($wingetCmd.Source)]" -ForegroundColor Green
    } catch {
        Write-Host "WinGet Installed         : " -NoNewline
        Write-Host "Found, but failed to query version" -ForegroundColor Yellow
    }
} else {
    Write-Host "WinGet Installed         : " -NoNewline
    Write-Host "No (Not found on PATH)" -ForegroundColor Red
}

# 5. Python Check
$pythonCmd = Get-Command python -ErrorAction SilentlyContinue
if ($pythonCmd) {
    try {
        $rawPyVer = & python --version 2>&1
        $pyVer = ($rawPyVer | Out-String).Trim()
        Write-Host "Python Installed         : " -NoNewline
        Write-Host "Yes ($pyVer) [$($pythonCmd.Source)]" -ForegroundColor Green
    } catch {
        Write-Host "Python Installed         : " -NoNewline
        Write-Host "Found, but failed to query version" -ForegroundColor Yellow
    }
} else {
    Write-Host "Python Installed         : " -NoNewline
    Write-Host "No (Not found on PATH)" -ForegroundColor Red
}

Write-Host "============================================================" -ForegroundColor Cyan
