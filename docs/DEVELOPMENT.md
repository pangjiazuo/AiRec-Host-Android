# 开发说明

## 代码在哪里

| 目录 | 负责什么 |
| --- | --- |
| `app/src/main/java/com/airec/host/capture` | 两组 AHD 采集、裁剪、预览、录像切片 |
| 同级 `detection` | 独立 NPU 进程、YOLO 输出、ByteTrack 和事件 |
| 同级 `storage` | SQLite 索引、SD 卡、循环清理、全天时间轴 |
| 同级 `web` | 局域网 HTTP、MJPEG、MP4 范围回放、日志下载 |
| 同级 `core` | 配置、设备状态和日志 |
| `app/src/main/cpp` | 取得视频描述符、V4L2 内存映射、RKNN JNI |
| `web-src` / `app/src/main/assets/web` | 可编辑网页脚本 / APK 内网页 |

普通业务使用 Java，只有硬件调用使用 C++。预览和录像在后台服务运行，Activity 关闭不等于停止录像。

## 修改界面

板载 WebView 版本较旧。使用 esbuild 0.25.10 把源码转换为 Chrome 66 可执行的语法：

```text
esbuild web-src/app.js --target=chrome66 --outfile=app/src/main/assets/web/app.js
```

HTML、CSS 和 `compat.js` 可直接编辑。生成后的 `app.js` 也保留在仓库，所以普通 APK 构建不依赖 Node.js。界面使用相同 HTTP 接口，浏览器和主机 WebView 均可访问。

## 测试

`scripts/build.ps1` 会编译 APK 并运行 ByteTrack 单元测试。`app/src/androidTest` 另外包含真机检查：无信号判断、配置校验、官方测试图的 NPU 推理，以及四个硬件编码器加一个软件编码器。

安装测试 APK 后，运行 `com.airec.host.test/com.airec.host.HostTests`。参数 `image` 指向板上的独立测试 JPEG，`codecs=yes` 开启五编码器合成画面测试。测试不会把这些图片保存成业务事件。

操作开发板前只选定它的 ADB 序列号，避免安装到手机。升级前先在主机页面停止录像，等当前片段封装完成，再覆盖安装。

## 移植到其他固件

先核对 `/dev/video0`、`/dev/video5` 的分辨率、YUYV 格式和媒体链路，再调整采集映射。当前主机使用本板已有的 `su 0`；没有权限时显示错误，不会修改系统权限或刷写固件。

NPU 库适配 RK3399PRO，不能拿去直接运行 RK3588/RK3568。新的芯片要换运行库、重新转换模型并验证输出。五路录像的编码器数量和帧率也需要重新测试。
