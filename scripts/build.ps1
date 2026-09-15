param([string]$Ndk = $env:ANDROID_NDK_HOME, [switch]$Offline, [switch]$Install, [string]$Device = '192.168.10.209:5555')
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path $PSScriptRoot -Parent
if (-not $env:JAVA_HOME) { $env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr' }
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
Push-Location $ProjectRoot
try {
    foreach ($File in (Get-Content web-files.json -Raw | ConvertFrom-Json)) {
        if ((Get-FileHash -LiteralPath $File.path).Hash -ne $File.sha256) { throw "网页源码已变化，请先运行 scripts/build-web.ps1：$($File.path)" }
    }
    foreach ($File in (Get-Content privacy-sdk.json -Raw | ConvertFrom-Json)) {
        if (-not (Test-Path -LiteralPath $File.path) -or (Get-FileHash -LiteralPath $File.path).Hash -ne $File.sha256) {
            throw "缺少已验证的隐私 SDK 文件：$($File.path)。请先运行 scripts/prepare-privacy-sdk.ps1，说明见 docs/PRIVACY.md。"
        }
    }
    if ($Ndk) {
        $Compiler = Join-Path $Ndk 'toolchains\llvm\prebuilt\windows-x86_64\bin\clang++.exe'
        $LibraryDir = 'app/src/main/jniLibs/arm64-v8a'
        & $Compiler --target=aarch64-linux-android28 -shared -fPIC -O2 -std=c++17 -static-libstdc++ app/src/main/cpp/detector.cpp "-L$LibraryDir" -lrknn_api -ljnigraphics -llog -o "$LibraryDir/libairec_detector.so"
        if ($LASTEXITCODE -ne 0) { throw 'NPU JNI 编译失败' }
        & $Compiler --target=aarch64-linux-android28 -shared -fPIC -O2 -std=c++17 -static-libstdc++ app/src/main/cpp/video.cpp -lGLESv2 -o "$LibraryDir/libairec_video.so"
        if ($LASTEXITCODE -ne 0) { throw '视频 JNI 编译失败' }
        & $Compiler --target=aarch64-linux-android28 -fPIE -pie -O2 -std=c++17 -static-libstdc++ app/src/main/cpp/video_fd.cpp -o "$LibraryDir/libairec_fd.so"
        if ($LASTEXITCODE -ne 0) { throw '视频权限助手编译失败' }
        & $Compiler --target=aarch64-linux-android28 -shared -fPIC -O2 -std=c++17 -static-libstdc++ app/src/main/cpp/privacy.cpp -ldl -o "$LibraryDir/libairec_privacy.so"
        if ($LASTEXITCODE -ne 0) { throw '隐私 JNI 编译失败' }
        $NativeFiles = @(Get-ChildItem app/src/main/cpp -File) + @(Get-ChildItem $LibraryDir -Filter *.so -File)
        $Manifest = foreach ($File in $NativeFiles) {
            @{ path = $File.FullName.Substring($ProjectRoot.Length + 1).Replace('\', '/'); sha256 = (Get-FileHash $File.FullName -Algorithm SHA256).Hash }
        }
        $Manifest | ConvertTo-Json | Set-Content native-files.json -Encoding utf8
    } else {
        if (-not (Test-Path native-files.json)) { throw '缺少原生库校验清单，请用 -Ndk 构建一次。' }
        foreach ($File in (Get-Content native-files.json -Raw | ConvertFrom-Json)) {
            if (-not (Test-Path -LiteralPath $File.path) -or (Get-FileHash -LiteralPath $File.path -Algorithm SHA256).Hash -ne $File.sha256) {
                throw "原生源码或库已修改：$($File.path)。请使用 -Ndk 重新构建，避免打包旧库。"
            }
        }
        Write-Host '使用已附带的 ARM64 原生库；修改 C++ 后请用 -Ndk 指定 Android NDK。'
    }
    $GradleArgs = @(':app:assembleDebug', ':app:testDebugUnitTest', '--console=plain')
    if ($Offline) { $GradleArgs += '--offline' }
    & .\gradlew.bat @GradleArgs
    if ($LASTEXITCODE -ne 0) { throw '构建或测试失败' }
    New-Item -ItemType Directory -Force dist | Out-Null
    Copy-Item app/build/outputs/apk/debug/app-debug.apk dist/AiRec-Host-Android.apk -Force
    Get-FileHash dist/AiRec-Host-Android.apk -Algorithm SHA256
    if ($Install) {
        $Adb = Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe'
        # 升级前正常停止服务，等待当前片段写完，不能强杀正在录像的进程。
        $BeforeServices = (& $Adb -s $Device shell dumpsys activity services com.airec.host) -join "`n"
        $BeforeStopLog = [string](& $Adb -s $Device shell run-as com.airec.host tail -n 20 files/logs/host.log | Select-String '采集与片段封装已停止' | Select-Object -Last 1)
        & $Adb -s $Device shell am start -f 0x20000000 -n com.airec.host/.MainActivity --ez stop true
        if ($LASTEXITCODE -ne 0) { throw '无法请求停止录像，取消安装' }
        $Deadline = (Get-Date).AddSeconds(40)
        do {
            $Services = & $Adb -s $Device shell dumpsys activity services com.airec.host
            if ($LASTEXITCODE -ne 0) { throw '无法确认服务停止' }
            if (($Services -join "`n") -notmatch 'ServiceRecord.*RecorderService') {
                $StopLines = @(& $Adb -s $Device shell run-as com.airec.host tail -n 20 files/logs/host.log | Select-String '采集与片段封装已停止')
                if ($BeforeServices -notmatch 'ServiceRecord.*RecorderService' -or ($StopLines.Count -gt 0 -and $StopLines[-1].ToString() -ne $BeforeStopLog)) { break }
            }
            if ((Get-Date) -gt $Deadline) { throw '录像服务尚未停止，取消覆盖安装' }
            Start-Sleep -Milliseconds 500
        } while ($true)
        & $Adb -s $Device install -r -g dist/AiRec-Host-Android.apk
        if ($LASTEXITCODE -ne 0) { throw 'APK 安装失败' }
        & $Adb -s $Device shell am start -n com.airec.host/.MainActivity
        if ($LASTEXITCODE -ne 0) { throw '应用启动失败' }
        # Activity 启动命令返回时服务可能还没创建，确认已恢复后才报告部署完成。
        $StartDeadline = (Get-Date).AddSeconds(20)
        do {
            $StartedServices = (& $Adb -s $Device shell dumpsys activity services com.airec.host) -join "`n"
            if ($LASTEXITCODE -ne 0) { throw '无法确认录像服务启动' }
            if ($StartedServices -match 'ServiceRecord.*RecorderService') { break }
            if ((Get-Date) -gt $StartDeadline) { throw '应用已安装，但录像服务未恢复，请查看设备日志' }
            Start-Sleep -Milliseconds 500
        } while ($true)
    }
} finally { Pop-Location }
