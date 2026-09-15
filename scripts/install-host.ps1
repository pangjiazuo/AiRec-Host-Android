#requires -Version 5.1
param(
    [string]$Device = '192.168.10.209:5555',
    [string]$Apk,
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$Package = 'com.airec.host'
$Activity = 'com.airec.host/.MainActivity'

# 只接受明确的 IPv4 地址，所有设备命令固定指向这一台主机。
if ($Device -notmatch '^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$') { throw '地址格式：192.168.10.209 或 192.168.10.209:5555' }
$BoardAddress = $Matches[1]
$Port = if ($Matches[2]) { [int]$Matches[2] } else { 5555 }
if (@($BoardAddress.Split('.') | Where-Object { [int]$_ -gt 255 }).Count -or $Port -lt 1 -or $Port -gt 65535) { throw 'IP 或端口无效' }
$Device = "${BoardAddress}:$Port"
if (-not $Apk) {
    # 优先使用调用时当前文件夹；双击入口会切换到脚本所在文件夹。
    $Candidates = @(Get-ChildItem -LiteralPath (Get-Location).Path -Filter *.apk -File)
    if ($Candidates.Count -eq 0 -and (Get-Location).Path -ne $PSScriptRoot) {
        $Candidates = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter *.apk -File)
    }
    if ($Candidates.Count -ne 1) { throw '请在当前文件夹放置一个主机 APK；有多个时，用 -Apk 指定安装包。' }
    $Apk = $Candidates[0].FullName
}
$Apk = (Resolve-Path -LiteralPath $Apk).Path
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Zip = [IO.Compression.ZipFile]::OpenRead($Apk)
try {
    if (-not $Zip.GetEntry('lib/arm64-v8a/libairec_video.so')) { throw '这不是支持的 AiRec 主机 APK，请勿选择手机客户端。' }
    $Entry = $Zip.GetEntry('AndroidManifest.xml')
    if (-not $Entry) { throw 'APK 缺少清单文件' }
    $Stream = $Entry.Open(); $Buffer = [IO.MemoryStream]::new()
    try { $Stream.CopyTo($Buffer); $Bytes = $Buffer.ToArray() } finally { $Stream.Dispose(); $Buffer.Dispose() }
    if (-not ([Text.Encoding]::UTF8.GetString($Bytes).Contains($Package) -or [Text.Encoding]::Unicode.GetString($Bytes).Contains($Package))) {
        throw 'APK 包名校验失败'
    }
} finally { $Zip.Dispose() }
Write-Host "安装包：$Apk"
Write-Host "SHA256：$((Get-FileHash -LiteralPath $Apk -Algorithm SHA256).Hash)"

# 优先复用已有 SDK；缺少时下载官方便携工具，不需要管理员权限。
$Paths = @()
$Existing = Get-Command adb.exe -ErrorAction SilentlyContinue
if ($Existing) { $Paths += $Existing.Source }
foreach ($Sdk in @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, "$env:LOCALAPPDATA\Android\Sdk")) {
    if ($Sdk) { $Paths += (Join-Path $Sdk 'platform-tools\adb.exe') }
}
$Paths += (Join-Path $PSScriptRoot 'platform-tools\adb.exe')
$ToolRoot = Join-Path $env:LOCALAPPDATA 'AiRec\tools'
$Paths += (Join-Path $ToolRoot 'platform-tools\adb.exe')
$Adb = $null
foreach ($Candidate in $Paths) {
    if (Test-Path -LiteralPath $Candidate) {
        $Version = & $Candidate version 2>&1
        if ($LASTEXITCODE -eq 0 -and "$Version" -match 'Android Debug Bridge') { $Adb = $Candidate; break }
    }
}
if (-not $Adb) {
    Write-Host '未找到 ADB，正在从 Google 下载 Platform-Tools（首次需要联网）……'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    New-Item -ItemType Directory -Force -Path $ToolRoot | Out-Null
    $Archive = Join-Path $ToolRoot 'platform-tools.zip'
    Invoke-WebRequest 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip' -OutFile $Archive -UseBasicParsing -TimeoutSec 180
    Expand-Archive -LiteralPath $Archive -DestinationPath $ToolRoot -Force
    $Adb = Join-Path $ToolRoot 'platform-tools\adb.exe'
    & $Adb version
    if ($LASTEXITCODE -ne 0) { throw 'ADB 下载后无法运行，请检查 Windows 兼容性或安全软件。' }
}
Write-Host "ADB：$Adb"
function Invoke-Adb([string[]]$Arguments) {
    # Windows PowerShell 会把正常的 ADB stderr 提示当作错误记录，按退出码判断。
    $ErrorActionPreference = 'Continue'
    $Result = & $Adb @Arguments 2>&1
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -ne 0) { throw "ADB 执行失败：$($Arguments -join ' ')`n$($Result -join "`n")" }
    return ($Result -join "`n")
}
function Board([string[]]$Arguments) { Invoke-Adb (@('-s', $Device) + $Arguments) }
Write-Host (Invoke-Adb @('connect', $Device))
if ((Board @('get-state')).Trim() -ne 'device') { throw '主机未连接。请开启网络 ADB 调试，并在主机屏幕允许调试授权。' }
$Model = (Board @('shell', 'getprop', 'ro.product.model')).Trim()
$Abi = Board @('shell', 'getprop', 'ro.product.cpu.abilist')
$Api = (Board @('shell', 'getprop', 'ro.build.version.sdk')).Trim()
Write-Host "设备：$Model，Android API $Api，$Device"
if ($Api -ne '28' -or $Abi -notmatch 'arm64-v8a') { throw '当前脚本仅部署到已适配的 Android 9 ARM64 固件。' }
if ((Board @('shell', 'su', '0', 'id')) -notmatch 'uid=0') { throw '固件不支持 su 0，无法访问 AHD。' }
$Nodes = Board @('shell', 'ls', '/dev/video0', '/dev/video5')
if ($Nodes -notmatch '/dev/video0' -or $Nodes -notmatch '/dev/video5') { throw '缺少预期的 AHD 设备节点' }
if ($CheckOnly) { Write-Host '预检查通过；未安装 APK、未停用应用、未改变录像状态。'; return }

$Installed = (Board @('shell', 'pm', 'list', 'packages', $Package)) -match '(?m)^package:com\.airec\.host\s*$'
if ($Installed) {
    Write-Host '等待现有录像安全停止……'
    $WasRunning = (Board @('shell', 'dumpsys', 'activity', 'services', $Package)) -match 'ServiceRecord.*RecorderService'
    $Marker = 'airec-install-' + [Guid]::NewGuid().ToString('N')
    $null = Board @('shell', 'log', '-t', 'AiRecDeploy', $Marker)
    $null = Board @('shell', 'am', 'start', '-W', '-f', '0x20000000', '-n', $Activity, '--ez', 'stop', 'true')
    if ($WasRunning) {
        $Stopped = $false
        for ($Attempt = 0; $Attempt -lt 45; $Attempt++) {
            $Logs = Board @('logcat', '-d', '-s', 'AiRecHost:I', 'AiRecDeploy:I', '*:S')
            $Index = $Logs.LastIndexOf($Marker)
            if ($Index -ge 0 -and $Logs.Substring($Index).Contains('采集与片段封装已停止')) { $Stopped = $true; break }
            Start-Sleep -Seconds 1
        }
        if (-not $Stopped) { throw '未确认录像片段已写入，已取消安装。请检查主机；需要时手动重新启动录像。' }
    }
}
Write-Host '上传并覆盖安装 APK，保留原有录像与设置……'
$InstallResult = Board @('install', '-r', $Apk)
if ($InstallResult -notmatch '(?m)^Success\s*$') { throw "安装未成功：$InstallResult。不会自动卸载或降级。" }

if ((Board @('shell', 'pm', 'list', 'packages', 'com.neardi.factorytest')) -match 'package:com.neardi.factorytest') {
    Write-Host '停用工厂老化测试及其开机接收器……'
    $null = Board @('shell', 'su', '0', 'pm', 'disable-user', '--user', '0', 'com.neardi.factorytest')
    $Disabled = Board @('shell', 'pm', 'list', 'packages', '-d', 'com.neardi.factorytest')
    if ($Disabled -notmatch 'package:com.neardi.factorytest') { throw '未能停用老化测试，请检查主机。' }
} else { Write-Host '未发现已知的老化测试包，无需停用。' }
$null = Board @('shell', 'pm', 'enable', '--user', '0', $Package)
$null = Board @('shell', 'pm', 'enable', '--user', '0', 'com.airec.host/.BootReceiver')
$null = Board @('shell', 'pm', 'grant', $Package, 'android.permission.CAMERA')
# 安全停止已经完成，清除旧 Activity 的 stop Intent，确保走首次启动逻辑。
$null = Board @('shell', 'am', 'force-stop', $Package)
$StartResult = Board @('shell', 'am', 'start', '-W', '-n', $Activity)
if ($StartResult -match 'Error:|Exception') { throw "启动失败：$StartResult" }
Write-Host '验证服务与开机恢复设置……'
$Ready = $false
for ($Attempt = 0; $Attempt -lt 30; $Attempt++) {
    $Prefs = Board @('shell', 'su 0 cat /data/user/0/com.airec.host/shared_prefs/host.xml 2>/dev/null; true')
    $Services = Board @('shell', 'dumpsys', 'activity', 'services', $Package)
    if ($Prefs -match '<boolean\s+name="enabled"\s+value="true"' -and $Services -match 'ServiceRecord.*RecorderService') { $Ready = $true; break }
    Start-Sleep -Seconds 1
}
if (-not $Ready) { throw 'APK 已安装，但未确认录像服务和开机恢复正常，请在主机查看错误或下载日志。' }
try {
    $Health = Invoke-RestMethod "http://${BoardAddress}:8080/api/health" -TimeoutSec 10
    if (-not $Health.ok) { throw '服务状态异常' }
    Write-Host "局域网接口正常，版本：$($Health.version)"
} catch { Write-Warning '后台服务已启动，但 Windows 无法访问 8080，请检查网络或防火墙。' }
Write-Host "完成！已启用开机恢复。访问：http://${BoardAddress}:8080"
Write-Host '未自动重启。请在界面确认画面、存储和识别状态；点击停止录像会取消下次开机恢复。'
