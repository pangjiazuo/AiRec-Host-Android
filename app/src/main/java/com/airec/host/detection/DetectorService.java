package com.airec.host.detection;

import android.app.Service;
import android.content.Intent;
import android.graphics.*;
import android.os.*;
import com.airec.host.core.*;
import java.io.*;
import java.security.MessageDigest;

/** 厂商 NPU 库独立进程运行；驱动故障不会拖垮录像服务。 */
public final class DetectorService extends Service {
  private HandlerThread worker;
  private Messenger inbox;
  private long handle;
  private final Handler watchdog = new Handler(Looper.getMainLooper());
  private final Runnable killHungProcess =
      () -> android.os.Process.killProcess(android.os.Process.myPid());
  public static final String MODEL_SHA256 =
      "885edffddd3195dcd382a1de1348fbaec5652bc530e4c49ba47a8fe3b3f41826";

  public void onCreate() {
    super.onCreate();
    worker = new HandlerThread("npu");
    worker.start();
    inbox = new Messenger(new Handler(worker.getLooper(), this::receive));
  }

  private boolean receive(Message m) {
    Message reply = Message.obtain(null, m.what);
    Bundle data = new Bundle();
    watchdog.postDelayed(killHungProcess, 30000);
    try {
      if (m.what == 9) {
        android.os.Process.killProcess(android.os.Process.myPid());
        return true;
      }
      if (handle == 0) {
        File model = new File(getFilesDir(), "yolov5s.rknn");
        if (!model.isFile() || !hash(model).equals(MODEL_SHA256))
          try (InputStream in = getAssets().open("models/yolov5s_relu_out_opt.rknn");
              OutputStream out = new FileOutputStream(model)) {
            byte[] b = new byte[65536];
            int n;
            while ((n = in.read(b)) > 0) out.write(b, 0, n);
          }
        if (!hash(model).equals(MODEL_SHA256)) throw new IOException("模型 SHA256 校验失败");
        data.putBoolean("model_verified", true);
        handle = NativeDetector.open(model.getAbsolutePath());
      }
      data.putString("version", NativeDetector.version(handle));
      data.putBoolean("model_verified", true);
      if (m.what == 2) {
        byte[] bytes = m.getData().getByteArray("jpeg");
        Bitmap source = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        if (source == null) throw new IOException("无法解码识别图像");
        Bitmap input = Bitmap.createBitmap(640, 640, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(input);
        canvas.drawColor(Color.BLACK);
        float scale = Math.min(640f / source.getWidth(), 640f / source.getHeight());
        float w = source.getWidth() * scale, h = source.getHeight() * scale;
        canvas.drawBitmap(
            source,
            null,
            new RectF((640 - w) / 2, (640 - h) / 2, (640 + w) / 2, (640 + h) / 2),
            new Paint(Paint.FILTER_BITMAP_FLAG));
        try {
          float[] boxes = NativeDetector.run(handle, input, m.getData().getFloat("threshold", .1f));
          for (int i = 0; i < boxes.length; i += 7) {
            boxes[i] = clip((boxes[i] - (640 - w) / 2) / w);
            boxes[i + 2] = clip((boxes[i + 2] - (640 - w) / 2) / w);
            boxes[i + 1] = clip((boxes[i + 1] - (640 - h) / 2) / h);
            boxes[i + 3] = clip((boxes[i + 3] - (640 - h) / 2) / h);
          }
          data.putFloatArray("boxes", boxes);
        } finally {
          source.recycle();
          input.recycle();
        }
      }
    } catch (Throwable e) {
      data.putString("error", e.toString());
      android.util.Log.e("AiRecNpu", "NPU", e);
    } finally {
      watchdog.removeCallbacks(killHungProcess);
    }
    reply.setData(data);
    try {
      m.replyTo.send(reply);
    } catch (Exception ignored) {
    }
    return true;
  }

  private float clip(float x) {
    return Math.max(0, Math.min(1, x));
  }

  private String hash(File file) throws Exception {
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    try (InputStream in = new FileInputStream(file)) {
      byte[] b = new byte[65536];
      int n;
      while ((n = in.read(b)) > 0) digest.update(b, 0, n);
    }
    StringBuilder text = new StringBuilder();
    for (byte b : digest.digest())
      text.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
    return text.toString();
  }

  public IBinder onBind(Intent i) {
    return inbox.getBinder();
  }

  public void onDestroy() {
    watchdog.postDelayed(killHungProcess, 5000);
    new Handler(worker.getLooper())
        .post(
            () -> {
              try {
                if (handle != 0) NativeDetector.close(handle);
              } finally {
                handle = 0;
                watchdog.removeCallbacks(killHungProcess);
                worker.quitSafely();
              }
            });
    super.onDestroy();
  }
}
