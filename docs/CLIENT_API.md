# 客户端接口

主机地址：`http://开发板IP:8080`。通道编号 1～5，JSON 使用 UTF-8，错误返回 `{"error":"原因"}` 和非 200 状态码。安卓、鸿蒙客户端仍使用原来的接口。

| 方法和路径 | 用途 |
| --- | --- |
| `GET /api/health` | 服务是否运行 |
| `GET /api/status` | 五路状态、真实帧率、识别框、设备和存储信息 |
| `GET /api/config` | 读取完整配置 |
| `PUT /api/config` | 保存完整配置，返回 `ok`、`config`、`restart_required:false` |
| `GET /api/storage/targets` | 获取内置存储和可写 SD 卡的 ID |
| `GET /api/devices` | 查看两组 AHD 视频源 |
| `GET /stream/1.mjpg` | 实时 MJPEG，其他通道替换编号 |
| `GET /api/snapshot/1.jpg` | 当前截图；无画面返回 503 |
| `GET /api/recordings?channel_id=1` | 最近 200 条已完成录像，返回 `items` |
| `GET /api/events?channel_id=1&event_type=person` | 筛选事件，返回 `items` |
| `GET /api/timeline?channel_id=1&start=...&end=...` | 完整时间范围内的录像和事件区间 |
| `GET /media/文件ID` | 使用列表返回的地址回放；支持单段 Range 和 HEAD |
| `GET /api/diagnostics/model` | 模型校验、运行库版本、NPU/VPU 状态 |
| `GET /api/logs`、`GET /api/logs/download` | 日志列表和 ZIP 下载 |

设置先读取再修改，不要用不完整的 JSON 覆盖。最多提交 64KB，录像时长仅支持 1、3、5、10 分钟。未识别的旧配置字段会保留，但远程访问等未实现功能不会因此启用。

事件类别为 `person`、`vehicle`、`animal`、`dwell`，筛选参数可以省略。停留事件只针对人和动物，颜色由客户端绘制。

时间轴的 `start`、`end` 使用带时区的 ISO8601，并做 URL 编码，例如 `2026-09-12T00:00:00+08:00`。窗口最大 26 小时，采用 `[start,end)`；响应包含 `recordings` 和 `event_segments`。它查询完整范围，不受最近 200 条列表限制。

正在写入的片段不参与回放。真实空白不能补成录像；介质拔出后可能返回 `available:false`。已获取的媒体链接也可能因循环清理而返回 404。

HTTP 服务仅面向可信局域网；不提供账号、远程重启或任意文件访问。`/api/remote-access` 只返回未启用状态。
