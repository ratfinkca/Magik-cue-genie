$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$tmpDir = Join-Path $projectRoot ".tmp"

New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

$env:TMP = $tmpDir
$env:TEMP = $tmpDir

Set-Location $projectRoot
python -m pytest --basetemp .\.tmp\pytest
