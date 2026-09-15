param([Parameter(Mandatory=$true)][string]$SdkDirectory)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path $PSScriptRoot -Parent
$SdkRoot = (Resolve-Path -LiteralPath $SdkDirectory).Path
$Files = Get-Content (Join-Path $ProjectRoot 'privacy-sdk.json') -Raw | ConvertFrom-Json
# 先检查全部文件，再写工程；不要混入其他芯片或不同版本的 SDK。
foreach ($File in $Files) {
    $Source = Join-Path $SdkRoot $File.sdk_path
    if (-not (Test-Path -LiteralPath $Source) -or (Get-FileHash -LiteralPath $Source).Hash -ne $File.sha256) {
        throw "SDK 文件缺失或与已验证版本不同：$($File.sdk_path)"
    }
}
foreach ($File in $Files) {
    $Destination = Join-Path $ProjectRoot $File.path
    New-Item -ItemType Directory -Force (Split-Path $Destination) | Out-Null
    Copy-Item -LiteralPath (Join-Path $SdkRoot $File.sdk_path) -Destination $Destination -Force
}
Write-Host '隐私 SDK 已就绪。分发 SDK 或包含它的 APK 前，请确认厂商授权。'
