# Build a self-contained runtime in .\runtime\python (Windows x64): embeddable Python + all packages.
# After this, the whole NWD folder can be copied to any Windows 10/11 x64 PC and run with start.bat
# - no Python install, no internet needed there.
#
# Run (on a PC with internet):  powershell -ExecutionPolicy Bypass -File tools\make-portable.ps1
param([string]$Version = "3.14.5")
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$rt = Join-Path $root "runtime\python"
$tag = ($Version -split "\.")[0..1] -join ""          # 3.14.5 -> 314

# pip needs a full Python of the same version to install into the embeddable one
$hostPy = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path $hostPy)) { $hostPy = (Get-Command python.exe).Source }
$hostVer = & $hostPy -c "import platform; print(platform.python_version())"
if (($hostVer -split "\.")[0..1] -join "" -ne $tag) { throw "Need Python $Version on this PC to install packages (found $hostVer)" }

if (Test-Path $rt) { Remove-Item -Recurse -Force $rt }
New-Item -ItemType Directory -Force $rt | Out-Null
$zip = Join-Path $env:TEMP "python-$Version-embed-amd64.zip"
Write-Host "Downloading Python $Version embeddable..."
Invoke-WebRequest "https://www.python.org/ftp/python/$Version/python-$Version-embed-amd64.zip" -OutFile $zip -UseBasicParsing
Expand-Archive $zip $rt
Remove-Item $zip

# the embeddable build ignores PYTHONPATH and site-packages unless its ._pth file says so
@"
python$tag.zip
.
Lib\site-packages
..\..
import site
"@ | Set-Content -Encoding ascii (Join-Path $rt "python$tag._pth")

Write-Host "Installing packages..."
$req = Get-Content (Join-Path $root "requirements.txt") | Where-Object { $_ -notmatch "^\s*(#|pytest)" -and $_.Trim() }
$tmpReq = Join-Path $env:TEMP "nwd-req-runtime.txt"
$req | Set-Content -Encoding ascii $tmpReq
& $hostPy -m pip install --quiet --no-cache-dir --only-binary=:all: --target (Join-Path $rt "Lib\site-packages") -r $tmpReq
if ($LASTEXITCODE) { throw "pip install failed" }
Remove-Item $tmpReq

& (Join-Path $rt "python.exe") -c "import uvicorn, fastapi, netmiko, ntc_templates, cryptography; print('runtime OK')"
if ($LASTEXITCODE) { throw "runtime check failed" }
$mb = [math]::Round(((Get-ChildItem -Recurse -File $rt | Measure-Object Length -Sum).Sum / 1MB), 1)
Write-Host "Done: runtime\python ($mb MB)"
