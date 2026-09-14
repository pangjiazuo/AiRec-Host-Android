param([string]$Esbuild = 'esbuild')
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path $PSScriptRoot -Parent
Push-Location $ProjectRoot
try {
    & $Esbuild web-src/app.js --bundle --target=chrome66 --outfile=app/src/main/assets/web/app.js
    if ($LASTEXITCODE -ne 0) { throw '网页构建失败' }
    $Files = @(Get-ChildItem web-src -Filter *.js -File) + @(Get-Item app/src/main/assets/web/app.js)
    $Manifest = foreach ($File in $Files) {
        @{path=$File.FullName.Substring($ProjectRoot.Length+1).Replace('\','/'); sha256=(Get-FileHash $File.FullName).Hash}
    }
    $Manifest | ConvertTo-Json | Set-Content web-files.json -Encoding utf8
} finally { Pop-Location }
