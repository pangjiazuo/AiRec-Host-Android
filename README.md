# AiRec 安卓录像主机

把五路 AHD 的 RK3399PRO 开发板变成录像机。支持实时预览、录像回放、人车动物事件、马赛克和循环录像。可通过本机屏幕、网页或手机客户端操作。

## 安装

适用于已适配的 **Android 9 ARM64 固件**，需支持 `su 0`，视频和 NPU 驱动由固件提供。

1. 从 [Releases](https://github.com/pangjiazuo/AiRec-Host-Android/releases) 下载主机 APK，先接好摄像头再开机。
2. 将 APK 与 [install-host.cmd](scripts/install-host.cmd)、[install-host.ps1](scripts/install-host.ps1) 放在同一文件夹。
3. 开启主机网络 ADB 调试，双击 `install-host.cmd`，按提示输入主机 IP。自动准备 ADB、覆盖安装、停用老化测试并启用开机恢复。

端口默认 5555，也可直接指定地址，见[简短安装说明](scripts/安装说明.md)。首次缺少 ADB 时需要联网。

也可直接在主机上安装 APK 并打开授权；这种方式不会自动停用老化测试。

## 使用

在设置中选择录像位置和通道参数。同一局域网访问 `http://主机IP:8080`，手机客户端也填写这个地址。

升级请覆盖安装，卸载会删除应用私有目录中的录像和设置。点击“停止录像”会取消下次开机恢复。

## 界面

| 实时画面 | 录像回放 | 设置 |
| --- | --- | --- |
| <img src="docs/screenshots/live.png" width="240"> | <img src="docs/screenshots/recordings.png" width="240"> | <img src="docs/screenshots/settings.png" width="240"> |

截图使用测试数据或设置页面，不含现场人脸。

## 说明

目前仅实测一路摄像头；第五路使用软件编码，五路同时运行的帧率尚未验证。马赛克可能短暂漏遮挡，详见[马赛克说明](docs/PRIVACY.md)。

开发者使用 Android Studio 打开工程，运行 `scripts/build.ps1` 生成 APK。更多内容：[开发说明](docs/DEVELOPMENT.md) · [测试记录](docs/VERIFICATION.md) · [第三方组件](THIRD_PARTY_NOTICES.md)。RockX 公开分发授权尚未核实。
