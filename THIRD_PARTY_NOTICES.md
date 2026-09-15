# 使用的第三方组件

| 组件 | 用途 | 来源与许可 |
| --- | --- | --- |
| YOLOv5s ReLU | 人、车、动物识别模型 | [YOLOv5 GPL-3.0](licenses/YOLOv5-GPL-3.0.txt) |
| Rockchip RKNN Android 1.7.5 | 在 RK3399PRO NPU 上运行模型 | [官方仓库](https://github.com/airockchip/RK3399Pro_npu/tree/8858114555f1700e41e185b14ec3d266342f8059/rknn-api/librknn_api)、[Apache-2.0](licenses/RK3399Pro_npu-Apache-2.0.txt)，同时保留原始头文件声明 |
| ByteTrack | 高低置信度关联、卡尔曼预测和目标去重 | [MIT](licenses/ByteTrack-MIT.txt)；本项目为 Java 移植，不是 Python 包 |
| RockX 隐私定位模型与 Android 库 | 人脸、车牌马赛克 | 厂商专有 SDK；本地测试文件不进入仓库，公开分发须确认授权，见[说明](docs/PRIVACY.md) |
| Android NDK / LLVM | 视频与识别的原生封装、C++ 运行库 | [NDK 声明](licenses/Android-NDK-NOTICE.txt)、[LLVM 声明](licenses/LLVM-NOTICE.txt) |

网页和业务逻辑从同一工作区的 AiRec-Rec 移植，沿用项目的 [GPL-3.0](LICENSE)。各第三方组件保留自己的许可。

模型、Android RKNN 库和头文件来自 Rockchip 固定提交 `8858114555f1700e41e185b14ec3d266342f8059`。模型校验值可在应用“设备设置 → 识别模型”中查看。APK 不包含 RKNN Python wheel、MobileNet-SSD、Python 或第三方视频画面。
