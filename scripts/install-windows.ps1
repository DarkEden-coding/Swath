$ErrorActionPreference = 'Stop'

$RootDir = Resolve-Path (Join-Path $PSScriptRoot '..')
$AppName = 'Swath'
$ExeName = 'swath.exe'
$StartMenuDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$CommonStartMenuDir = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'
$ShortcutPath = Join-Path $StartMenuDir "$AppName.lnk"
$CommonShortcutPath = Join-Path $CommonStartMenuDir "$AppName.lnk"

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

$ReleaseDir = Join-Path $RootDir 'src-tauri\target\release'
$ExpectedExePath = Join-Path $ReleaseDir $ExeName

Write-Host "Building $AppName Tauri bundle for Windows..."
# The install uses the release executable directly, so generating an NSIS installer is wasted work.
Invoke-Checked npm run tauri:build -- --no-bundle

if (-not (Test-Path $ExpectedExePath)) {
  throw "Could not find built executable at $ExpectedExePath"
}

$Exe = Get-Item $ExpectedExePath
$Hash = (Get-FileHash -Algorithm SHA256 $Exe.FullName).Hash
Write-Host "Built executable: $($Exe.FullName)"
Write-Host "Modified: $($Exe.LastWriteTime.ToString('u'))"
Write-Host "SHA256: $Hash"

Write-Host "Creating Start Menu shortcut..."
New-Item -ItemType Directory -Force -Path $StartMenuDir | Out-Null

$WScriptShell = New-Object -ComObject WScript.Shell
$Shortcut = $WScriptShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $Exe.FullName
$Shortcut.WorkingDirectory = $Exe.DirectoryName
$Shortcut.Description = "$AppName ($Hash)"
$Shortcut.Save()

$SavedShortcut = $WScriptShell.CreateShortcut($ShortcutPath)
if ($SavedShortcut.TargetPath -ne $Exe.FullName) {
  throw "Shortcut target mismatch. Expected '$($Exe.FullName)', got '$($SavedShortcut.TargetPath)'."
}

if (Test-Path $CommonShortcutPath) {
  try {
    $CommonShortcut = $WScriptShell.CreateShortcut($CommonShortcutPath)
    if ($CommonShortcut.TargetPath -ne $Exe.FullName) {
      Write-Warning "A machine-wide Start Menu shortcut exists at '$CommonShortcutPath' and points to '$($CommonShortcut.TargetPath)'."
      Write-Warning "Launchers may prefer that stale shortcut. Remove it manually or rerun this script as Administrator to update it."
    }
  } catch {
    Write-Warning "Could not inspect machine-wide shortcut '$CommonShortcutPath': $_"
  }
}

Write-Host "Installed shortcut: $ShortcutPath -> $($Exe.FullName)"
Write-Host "Launchers that index the Start Menu, such as PowerToys Run or Flow Launcher, should now be able to find '$AppName'."
