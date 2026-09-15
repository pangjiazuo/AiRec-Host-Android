package com.airec.host;

import android.app.*;
import android.content.*;
import android.os.*;
import com.airec.host.capture.*;
import com.airec.host.core.*;
import com.airec.host.detection.*;
import com.airec.host.storage.*;
import com.airec.host.web.*;
import java.io.*;
import java.util.concurrent.*;
import org.json.*;

public final class RecorderService extends Service {
  public static volatile RecorderService instance;
  public Config config;
  public Store store;
  public final Channel[] channels = {
    new Channel(1), new Channel(2), new Channel(3), new Channel(4), new Channel(5)
  };
  public Metrics metrics;
  public Detection detection;
  public Capture capture;
  private HttpServer http;
  private PowerManager.WakeLock wake;
  private final ScheduledExecutorService maintenance = Executors.newSingleThreadScheduledExecutor();
  private long started;

  public void onCreate() {
    super.onCreate();
    instance = this;
    started = SystemClock.elapsedRealtime();
    Logs.init(new File(getFilesDir(), "logs"));
    NotificationManager nm = getSystemService(NotificationManager.class);
    nm.createNotificationChannel(
        new NotificationChannel("recording", "录像服务", NotificationManager.IMPORTANCE_LOW));
    PendingIntent pi =
        PendingIntent.getActivity(
            this,
            0,
            new Intent(this, MainActivity.class),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    startForeground(
        1,
        new Notification.Builder(this, "recording")
            .setSmallIcon(android.R.drawable.presence_video_online)
            .setContentTitle("AiRec 录像机正在运行")
            .setContentText("局域网访问：本机 IP:8080")
            .setContentIntent(pi)
            .setOngoing(true)
            .build());
    try {
      config = new Config(this);
      store = new Store(this, config);
      metrics = new Metrics(this);
      metrics.update();
      detection = new Detection(this, config, channels, store);
      http = new HttpServer(this);
      http.start();
      capture = new Capture(this, config, store, channels);
      wake =
          ((PowerManager) getSystemService(POWER_SERVICE))
              .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AiRec:recording");
      wake.acquire();
      maintenance.scheduleWithFixedDelay(
          () -> {
            try {
              metrics.update();
              capture.storageReady = store.cleanup();
            } catch (Exception e) {
              capture.storageReady = false;
              Logs.error("存储维护", e);
            }
          },
          1,
          5,
          TimeUnit.SECONDS);
      Logs.info("Android 主机启动 1.0.5");
    } catch (Exception e) {
      Logs.error("主机启动", e);
      stopSelf();
    }
  }

  public JSONObject status() {
    JSONArray array = new JSONArray();
    for (Channel c : channels) array.put(c.status(config.channel(c.id)));
    String target = config.storage().optString("target_id", "internal");
    long free = 0, total = 0;
    String error = "";
    try {
      File root = store.root(target);
      free = root.getUsableSpace();
      total = root.getTotalSpace();
    } catch (Exception e) {
      error = e.getMessage();
    }
    return J.obj(
        "channels",
        array,
        "system",
        metrics.get(),
        "storage",
        J.obj(
            "target_id",
            target,
            "free_bytes",
            free,
            "total_bytes",
            total,
            "recording_allowed",
            capture != null && capture.storageReady,
            "error",
            error),
        "detector",
        detection.status(),
        "uptime_seconds",
        (SystemClock.elapsedRealtime() - started) / 1000.0);
  }

  public JSONObject model() {
    JSONObject out = detection.status();
    JSONArray used = new JSONArray();
    for (Channel c : channels) if (c.recording && c.backend.startsWith("rockchip")) used.put(c.id);
    J.put(out, "name", "YOLOv5s ReLU (COCO 80)");
    J.put(out, "version", "固定 RKNN 模型 / Android SDK 1.7.5");
    J.put(out, "tracker", "ByteTrack Java");
    J.put(out, "privacy", J.obj("engine", "RockX RK3399PRO Android",
        "models", new JSONArray().put("face_detection.data").put("carplate_detection.data"),
        "pipeline", "间隔定位 + 逐帧图像跟踪 → GPU 马赛克 → MediaCodec H.264",
        "note", "单路约每500毫秒定位，多路时增加间隔；快速新目标可能短暂漏遮挡，不识别人脸身份或车牌文字"));
    J.put(out, "commit", "8858114555f1700e41e185b14ec3d266342f8059");
    J.put(
        out,
        "files",
        new JSONArray()
            .put(
                J.obj(
                    "name",
                    "yolov5s_relu_out_opt.rknn",
                    "size_bytes",
                    7400912,
                    "sha256",
                    DetectorService.MODEL_SHA256,
                    "verified",
                    detection.modelVerified)));
    J.put(
        out,
        "category_mapping",
        J.obj(
            "person",
            new JSONArray().put("person"),
            "vehicle",
            new JSONArray(
                java.util.Arrays.asList("bicycle", "car", "motorbike", "bus", "train", "truck")),
            "animal",
            new JSONArray(
                java.util.Arrays.asList(
                    "bird",
                    "cat",
                    "dog",
                    "horse",
                    "sheep",
                    "cow",
                    "elephant",
                    "bear",
                    "zebra",
                    "giraffe"))));
    J.put(
        out,
        "vpu",
        J.obj(
            "used",
            used.length() > 0,
            "backend",
            "Rockchip MediaCodec H.264",
            "channels",
            used,
            "note",
            "硬件最多四个编码实例；第五路尝试软件编码，实际帧率以运行状态为准。"));
    J.put(
        out,
        "npu",
        J.obj(
            "used",
            detection.inferences > 0 && detection.ready,
            "backend",
            "RKNN Android 1.7.5",
            "note",
            detection.error));
    J.put(out, "limitations", new JSONArray().put("AHD2～5 的物理接口与四宫格位置仍需逐路接入摄像头校准。"));
    return out;
  }

  public int onStartCommand(Intent i, int flags, int id) {
    getSharedPreferences("host", 0).edit().putBoolean("enabled", true).apply();
    return START_STICKY;
  }

  public IBinder onBind(Intent i) {
    return null;
  }

  public void onDestroy() {
    instance = null;
    maintenance.shutdownNow();
    if (http != null) http.close();
    if (detection != null) detection.close();
    if (capture != null) capture.close();
    if (wake != null && wake.isHeld()) wake.release();
    Logs.info("录像服务关闭");
    super.onDestroy();
  }
}
