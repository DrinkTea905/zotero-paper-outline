# Build .xpi for Paper Outline GPT
# Run:  powershell -ExecutionPolicy Bypass -File .\打包.ps1
# (ASCII-only on purpose: Windows PowerShell 5.1 mis-decodes non-BOM UTF-8 Chinese in .ps1)

$ErrorActionPreference = "Stop"
$src = $PSScriptRoot
$zip = Join-Path $src "paper-outline-gpt.zip"
$xpi = Join-Path $src "paper-outline-gpt.xpi"

$names = @("manifest.json","bootstrap.js","paperOutline.js","prefs.js","preferences.xhtml")
$files = @()
foreach ($n in $names) { $files += (Join-Path $src $n) }

if (Test-Path $zip) { Remove-Item $zip -Force }
if (Test-Path $xpi) { Remove-Item $xpi -Force }

Compress-Archive -Path $files -DestinationPath $zip -Force
Rename-Item -Path $zip -NewName "paper-outline-gpt.xpi"

Write-Host "[OK] Built:" $xpi
Write-Host "Install: Zotero -> Tools -> Plugins -> gear -> Install Add-on From File -> pick the .xpi"
