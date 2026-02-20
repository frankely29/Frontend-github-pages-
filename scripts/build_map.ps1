$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectDir

$Py     = Join-Path $ProjectDir ".venv\Scripts\python.exe"
$Script = Join-Path $ProjectDir "tlc_hvfhs_hotspot_builder.py"
$Data   = Join-Path $ProjectDir "data"
$Out    = "outputs"

if (!(Test-Path $Py))     { throw "Missing venv python: $Py" }
if (!(Test-Path $Script)) { throw "Missing builder: $Script" }
if (!(Test-Path $Data))   { throw "Missing data folder: $Data" }

# EDIT THESE:
$Months = @("2024-01","2024-02")
$HourBin = 2
$SimplifyMeters = 60
$WinGoodN = 40
$WinBadN  = 20

Write-Host "Running builder..." -ForegroundColor Cyan
& $Py $Script --months $Months --data_dir $Data --out_dir $Out --hour_bin $HourBin --simplify_meters $SimplifyMeters --win_good_n $WinGoodN --win_bad_n $WinBadN

Write-Host "Done. Outputs are in .\outputs" -ForegroundColor Green
