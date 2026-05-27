$ErrorActionPreference = 'Stop'

$RootDir = Resolve-Path (Join-Path $PSScriptRoot '..')
$AppName = 'Swath'
$StartMenuDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$ShortcutPath = Join-Path $StartMenuDir "$AppName.lnk"

Set-Location $RootDir

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)]
    [string] $FilePath,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $Arguments
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$FilePath $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
  }
}

function Assert-WindowsNativeBuildPrerequisites {
  $VsWhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path $VsWhere)) {
    throw "Visual Studio Build Tools were not found. Install Visual Studio 2022 Build Tools with the Desktop development with C++ workload."
  }

  $InstallPaths = & $VsWhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if ($LASTEXITCODE -ne 0 -or -not $InstallPaths) {
    throw "Visual Studio C++ build tools were not found. Install the MSVC v143 x64/x86 build tools from Visual Studio Installer."
  }
}

$TauriBin = Join-Path $RootDir 'node_modules\.bin\tauri.cmd'

if (-not (Test-Path $TauriBin)) {
  Write-Host "Installing dependencies..."
  Invoke-Checked npm install
}

Assert-WindowsNativeBuildPrerequisites

Write-Host "Building $AppName Tauri bundle for Windows..."
Invoke-Checked npm run tauri:build

$Exe = Get-ChildItem -Path (Join-Path $RootDir 'src-tauri\target\release') -Recurse -Filter "$AppName.exe" |
  Where-Object { $_.FullName -notmatch '\\deps\\' } |
  Select-Object -First 1

if (-not $Exe) {
  throw "Could not find built executable at src-tauri\target\release\**\$AppName.exe"
}

Write-Host "Creating Start Menu shortcut..."
New-Item -ItemType Directory -Force -Path $StartMenuDir | Out-Null

$WScriptShell = New-Object -ComObject WScript.Shell
$Shortcut = $WScriptShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $Exe.FullName
$Shortcut.WorkingDirectory = $Exe.DirectoryName
$Shortcut.Description = $AppName
$Shortcut.Save()

Write-Host "Installed shortcut: $ShortcutPath"
Write-Host "Launchers that index the Start Menu, such as PowerToys Run or Flow Launcher, should now be able to find '$AppName'."
