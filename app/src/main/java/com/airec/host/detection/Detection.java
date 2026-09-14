package com.airec.host.detection;

import android.content.*;
import android.os.*;
import com.airec.host.core.*;
import com.airec.host.storage.Store;
import java.util.*;
import org.json.*;

public final class Detection implements AutoCloseable, ServiceConnection {
  private final Context context;
  private final Config config;
  private final Channel[] channels;
  private final Store store;
  private final Handler handler;
  private final HandlerThread worker = new HandlerThread("tracking");
  private Messenger remote, reply;
  private volatile boolean closed;
  private boolean bound, busy;
  private long sent, frameTime, frameMono;
  private byte[] frame;
  private int index, cursor;
  private final long[] next = new long[5], lastSeq = new long[5];
  private final String[] settings = new String[5];
  private final ByteTrack[] trackers = {
    new ByteTrack(), new ByteTrack(), new ByteTrack(), new ByteTrack(), new ByteTrack()
  };
  public volatile boolean ready;
  public volatile Boolean modelVerified;
  public volatile String error = "正在初始化 NPU", version = "";
  public volatile long inferences;
  public volatile double inferenceMs;
  private static final String[] CATEGORIES = {"person", "vehicle", "animal"};
  private static final String[] LABELS = {
    "person",
    "bicycle",
    "car",
    "motorbike",
    "aeroplane",
    "bus",
    "train",
    "truck",
    "boat",
    "traffic light",
    "fire hydrant",
    "stop sign",
    "parking meter",
    "bench",
    "bird",
    "cat",
    "dog",
    "horse",
    "sheep",
    "cow",
    "elephant",
    "bear",
    "zebra",
    "giraffe"
  };

  public Detection(Context c, Config config, Channel[] channels, Store store) {
    context = c;
    this.config = config;
    this.channels = channels;
    this.store = store;
    worker.start();
    handler = new Handler(worker.getLooper());
    reply = new Messenger(new Handler(worker.getLooper(), this::receive));
    handler.post(
        () -> {
          bind();
          tick();
        });
  }

  private void bind() {
    if (closed || bound) return;
    try {
      bound =
          context.bindService(
              new Intent(context, DetectorService.class), this, Context.BIND_AUTO_CREATE);
      if (!bound) error = "无法启动 NPU 进程";
    } catch (Exception e) {
      error = e.toString();
    }
  }

  public void onServiceConnected(ComponentName n, IBinder binder) {
    handler.post(
        () -> {
          remote = new Messenger(binder);
          send(1, null);
        });
  }

  public void onServiceDisconnected(ComponentName n) {
    handler.post(
        () -> {
          remote = null;
          ready = false;
          busy = false;
          error = "NPU 进程断开，录像继续运行";
          Logs.info(error);
        });
  }

  private void send(int what, Bundle data) {
    try {
      Message m = Message.obtain(null, what);
      m.replyTo = reply;
      if (data != null) m.setData(data);
      busy = true;
      sent = SystemClock.elapsedRealtime();
      remote.send(m);
    } catch (Exception e) {
      busy = false;
      ready = false;
      error = e.toString();
    }
  }

  private boolean receive(Message message) {
    if (closed) return true;
    busy = false;
    Bundle result = message.getData();
    if (result.containsKey("model_verified")) modelVerified = result.getBoolean("model_verified");
    String failure = result.getString("error", "");
    if (!failure.isEmpty()) {
      ready = false;
      error = failure;
      Logs.info("NPU：" + failure);
      return true;
    }
    version = result.getString("version", "");
    ready = true;
    error = "";
    if (message.what == 1) {
      Logs.info("NPU 模型就绪：" + version);
      return true;
    }
    inferenceMs = SystemClock.elapsedRealtime() - sent;
    inferences++;
    JSONObject c = config.channel(index + 1), d = c.optJSONObject("detection");
    if (!c.optBoolean("enabled") || !d.optBoolean("enabled")) return true;
    String signature = d.toString() + c.optJSONArray("crop");
    if (!signature.equals(settings[index])) {
      trackers[index].reset();
      settings[index] = signature;
    }
    float[] values = result.getFloatArray("boxes");
    List<ByteTrack.Box> boxes = new ArrayList<>();
    JSONArray allowed = d.optJSONArray("categories");
    Set<String> categories = new HashSet<>();
    for (int i = 0; i < allowed.length(); i++) categories.add(allowed.optString(i));
    if (values != null)
      for (int i = 0; i + 6 < values.length; i += 7) {
        int label = (int) values[i + 5], category = (int) values[i + 6];
        if (category < 0
            || category > 2
            || label < 0
            || label >= LABELS.length
            || !categories.contains(CATEGORIES[category])
            || values[i + 2] <= values[i]
            || values[i + 3] <= values[i + 1]) continue;
        boxes.add(
            new ByteTrack.Box(
                values[i],
                values[i + 1],
                values[i + 2],
                values[i + 3],
                values[i + 4],
                label,
                category));
      }
    double now = frameMono / 1000.0, high = d.optDouble("confidence", .5);
    JSONArray visible = new JSONArray();
    for (ByteTrack.Track track :
        trackers[index].update(boxes, now, high, d.optDouble("lost_tolerance_seconds", 2))) {
      ByteTrack.Box b = track.box;
      double dwell = track.seconds(now);
      boolean eligible = b.category != 1,
          reached = eligible && dwell >= d.optDouble("threshold_seconds", 3);
      JSONObject item =
          J.obj(
              "bbox",
              new JSONArray(Arrays.asList(b.x1, b.y1, b.x2, b.y2)),
              "label",
              LABELS[b.label],
              "category",
              CATEGORIES[b.category],
              "confidence",
              b.score,
              "track_id",
              track.id,
              "confirmed",
              track.confirmed,
              "dwell_seconds",
              dwell,
              "dwell_eligible",
              eligible,
              "dwell_reached",
              track.dwell,
              "event_type",
              track.dwell ? "dwell" : CATEGORIES[b.category]);
      visible.put(item);
      if (track.confirmed && b.score >= high) {
        if (!track.presence) {
          if (event(item, CATEGORIES[b.category])) track.presence = true;
        }
        if (reached && !track.dwell) {
          if (event(item, "dwell")) track.dwell = true;
        }
      }
      J.put(item, "dwell_reached", track.dwell);
      J.put(item, "event_type", track.dwell ? "dwell" : CATEGORIES[b.category]);
    }
    channels[index].detections = visible;
    return true;
  }

  private boolean event(JSONObject item, String type) {
    try {
      JSONObject detail = J.copy(item);
      J.put(detail, "event_type", type);
      J.put(detail, "dwell_reached", type.equals("dwell"));
      store.event(index + 1, frameTime, detail, frame);
      Logs.info("事件 ch" + (index + 1) + " " + type + " track=" + item.optInt("track_id"));
      return true;
    } catch (Exception e) {
      Logs.error("保存事件", e);
      return false;
    }
  }

  private void tick() {
    if (closed) return;
    long now = SystemClock.elapsedRealtime();
    if (busy && now - sent > 30000) {
      ready = false;
      error = "NPU 请求超过30秒；为保护录像已停止识别重试，请重启应用后查看日志";
      Logs.info(error);
      busy = false;
      remote = null;
    }
    if (!busy && ready && remote != null) {
      for (int n = 0; n < 5; n++) {
        int i = (cursor + n) % 5;
        Channel ch = channels[i];
        JSONObject c = config.channel(i + 1), d = c.optJSONObject("detection");
        if (!c.optBoolean("enabled")
            || !d.optBoolean("enabled")
            || ch.jpeg == null
            || System.currentTimeMillis() - ch.jpegTime > 4000) {
          trackers[i].expire(
              SystemClock.elapsedRealtime() / 1000.0, d.optDouble("lost_tolerance_seconds", 2));
          ch.detections = new JSONArray();
          continue;
        }
        if (now < next[i] || lastSeq[i] == ch.sequence) continue;
        index = i;
        frame = ch.jpeg;
        frameTime = ch.jpegTime;
        frameMono = ch.frameMono;
        lastSeq[i] = ch.sequence;
        cursor = (i + 1) % 5;
        next[i] = now + (long) (d.optDouble("sample_interval", 1) * 1000);
        Bundle b = new Bundle();
        b.putByteArray("jpeg", frame);
        b.putFloat("threshold", (float) Math.min(.1, d.optDouble("confidence", .5) / 2));
        send(2, b);
        break;
      }
    }
    handler.postDelayed(this::tick, 100);
  }

  public JSONObject status() {
    return J.obj(
        "ready",
        ready,
        "error",
        error,
        "backend",
        "rknn-android",
        "sdk_version",
        version,
        "tracker",
        "ByteTrack Java",
        "inferences",
        inferences,
        "inference_ms",
        inferenceMs);
  }

  public void close() {
    closed = true;
    handler.removeCallbacksAndMessages(null);
    if (bound) {
      context.unbindService(this);
      bound = false;
    }
    worker.quitSafely();
  }
}
