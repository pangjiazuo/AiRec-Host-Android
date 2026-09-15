package com.airec.host.core;

import android.os.SystemClock;
import org.json.*;

public final class Channel {
  public final int id;
  public volatile byte[] jpeg, analysisJpeg;
  public volatile String privacyError = "";
  public volatile double privacyMs;
  public volatile int publishedPrivacyFlags;
  public boolean privacyMatches(JSONObject setting) { return publishedPrivacyFlags == com.airec.host.privacy.PrivacyFrame.flags(setting); }
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
    publish(data, null, System.currentTimeMillis(), SystemClock.elapsedRealtime(), 0);
  }

  public synchronized void publish(byte[] data, byte[] analysis, long time, long mono, int privacyFlags) {
    jpeg = data; analysisJpeg = analysis; publishedPrivacyFlags = privacyFlags;
    jpegTime = time;
    frameMono = mono;
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
        "privacy_error", privacyError, "privacy_ms", privacyMs,
        "id",
        id,
        "name",
        c.optString("name"),
        "enabled",
        enabled,
        "state",
        state,
        "error",
        privacyError.isEmpty() ? error : privacyError,
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
