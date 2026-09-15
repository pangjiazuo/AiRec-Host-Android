package com.airec.host.privacy;

import android.content.Context;
import android.graphics.Bitmap;
import android.os.SystemClock;
import com.airec.host.capture.Signal;
import com.airec.host.core.Logs;
import java.io.*;
import java.nio.*;
import java.util.concurrent.*;
import org.json.JSONObject;

/** 异步定位任务或一帧的遮挡结果；原始图像只在内存中使用。 */
public final class PrivacyFrame {
  public static final int WIDTH = 640, HEIGHT = 360;
  private static final ExecutorService worker = new ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS,
      new ArrayBlockingQueue<>(10), r -> new Thread(r, "privacy-npu"));
  private static volatile long errorLogged;
  public final ByteBuffer pixels;
  public int texture;
  public boolean busy;
  public volatile boolean done;
  public float[] boxes = new float[0];
  public byte[] analysis;
  public Bitmap signalBitmap;
  public boolean missing;
  public String error = "";
  public long capturedAt, mono, started;
  public double elapsedMs;
  public final int flags;
  public PrivacyFrame(int flags) { this(flags, ByteBuffer.allocateDirect(WIDTH * HEIGHT * 4).order(ByteOrder.nativeOrder())); }
  public PrivacyFrame(int flags, ByteBuffer pixels) { this.flags = flags; this.pixels = pixels; }

  public static int flags(JSONObject channel) {
    JSONObject p = channel.optJSONObject("privacy");
    return p == null ? 0 : (p.optBoolean("face_mosaic") ? 1 : 0) | (p.optBoolean("plate_mosaic") ? 2 : 0);
  }

  public void submit(Context context, Runnable completed) {
    busy = true; done = false; started = SystemClock.elapsedRealtime();
    capturedAt = System.currentTimeMillis(); mono = started;
    try { worker.execute(() -> {
      Bitmap image = null;
      try {
        image = signalBitmap != null ? signalBitmap : Bitmap.createBitmap(WIDTH, HEIGHT, Bitmap.Config.ARGB_8888);
        pixels.rewind(); image.copyPixelsFromBuffer(pixels);
        missing = Signal.missing(image);
        if (!missing) {
          boxes = NativePrivacy.detect(context, pixels, WIDTH, HEIGHT, flags);
        }
      } catch (Throwable e) {
        error = "隐私检测失败，画面已全部遮挡";
        boxes = new float[]{0, 0, 1, 1}; analysis = null;
        if (SystemClock.elapsedRealtime() - errorLogged > 10000) {
          errorLogged = SystemClock.elapsedRealtime(); Logs.error("隐私检测", new Exception(e));
        }
      } finally {
        if (image != null && signalBitmap == null) image.recycle();
        elapsedMs = SystemClock.elapsedRealtime() - started;
        done = true;
        completed.run();
      }
    }); } catch (RejectedExecutionException e) {
      error = "隐私检测繁忙，画面已全部遮挡"; boxes = new float[]{0, 0, 1, 1}; done = true;
      completed.run();
    }
  }
}
