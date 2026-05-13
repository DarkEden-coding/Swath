$ErrorActionPreference = 'Stop'

$RootDir = Resolve-Path (Join-Path $PSScriptRoot '..')
$AppName = 'Swath'
$StartMenuDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$ShortcutPath = Join-Path $StartMenuDir "$AppName.lnk"

Set-Location $RootDir

Write-Host "Building $AppName for Windows..."
npm run build
npx electron-builder --win dir

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
