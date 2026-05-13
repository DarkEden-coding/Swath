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

  $SpectreLibs = foreach ($InstallPath in $InstallPaths) {
    Get-ChildItem -Path (Join-Path $InstallPath 'VC\Tools\MSVC') -Directory -ErrorAction SilentlyContinue |
      Where-Object { Test-Path (Join-Path $_.FullName 'lib\spectre\x64') }
  }

  if (-not $SpectreLibs) {
    throw "Missing Visual Studio Spectre-mitigated libraries required by node-pty. Open Visual Studio Installer > Modify > Individual components, then install 'MSVC v143 - VS 2022 C++ x64/x86 Spectre-mitigated libs' for the installed toolset."
  }
}

$ElectronBuilderBin = Join-Path $RootDir 'node_modules\.bin\electron-builder.cmd'

if (-not (Test-Path $ElectronBuilderBin)) {
  Write-Host "Installing dependencies..."
  Invoke-Checked npm install
}

Assert-WindowsNativeBuildPrerequisites

Write-Host "Building $AppName for Windows..."
Invoke-Checked npm run build --ignore-scripts
Invoke-Checked npx electron-builder --win dir

$Exe = Get-ChildItem -Path (Join-Path $RootDir 'release') -Recurse -Filter "$AppName.exe" |
  Where-Object { $_.FullName -match 'win.*unpacked' } |
  Select-Object -First 1

if (-not $Exe) {
  throw "Could not find built executable at release/**/win*-unpacked/$AppName.exe"
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
