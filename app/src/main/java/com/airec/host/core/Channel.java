package com.airec.host.core;

import android.os.SystemClock;
import org.json.*;

public final class Channel {
  public final int id;
  public volatile byte[] jpeg;
  public volatile long jpegTime, frameMono, sequence, lastFrame;
  public volatile boolean noSignal = true, recording;
  public volatile String error = "", backend = "";
  public volatile String captureBackend = "";
  public volatile double captureFps, previewFps, recordingFps;
  public volatile double jpegFps, localPreviewFps;
  public final java.util.concurrent.atomic.AtomicInteger viewers = new java.util.concurrent.atomic.AtomicInteger();
  public volatile JSONArray detections = new JSONArray();

  public Channel(int id) {
    this.id = id;
  }

  public synchronized void publish(byte[] data) {
    jpeg = data;
    jpegTime = System.currentTimeMillis();
    frameMono = SystemClock.elapsedRealtime();
    sequence++;
    notifyAll();
  }

  public JSONObject status(JSONObject c) {
    boolean enabled = c.optBoolean("enabled"),
        stale = SystemClock.elapsedRealtime() - lastFrame > 4000;
    String state =
        !enabled
            ? "disabled"
            : stale
                ? (error.isEmpty() ? "connecting" : "error")
                : noSignal ? "no_signal" : "online";
    return J.obj(
        "id",
        id,
        "name",
        c.optString("name"),
        "enabled",
        enabled,
        "state",
        state,
        "error",
        error,
        "recording",
        recording && !stale,
        "capture_fps",
        stale ? 0 : captureFps,
        "preview_fps",
        stale ? 0 : previewFps,
        "jpeg_fps", stale ? 0 : jpegFps,
        "local_preview_fps", stale ? 0 : localPreviewFps,
        "network_viewers", viewers.get(),
        "recording_fps",
        recordingFps,
        "fps",
        previewFps,
        "detections",
        detections,
        "encoder",
        backend,
        "capture_backend", captureBackend,
        "last_frame_at",
        jpegTime / 1000.0);
  }
}
