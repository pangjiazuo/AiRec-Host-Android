package com.airec.host.storage;

import android.content.*;
import android.database.*;
import android.database.sqlite.*;
import android.media.MediaMetadataRetriever;
import android.os.Environment;
import android.util.AtomicFile;
import com.airec.host.core.*;
import java.io.*;
import java.time.*;
import java.util.*;
import org.json.*;

/** 索引只发布封装完成的片段，清理只作用于本应用的媒体。 */
public final class Store extends SQLiteOpenHelper {
  private final Context context;
  private final Config config;

  public Store(Context context, Config config) {
    super(context, "recordings.db", null, 3);
    this.context = context;
    this.config = config;
    setWriteAheadLoggingEnabled(true);
    getWritableDatabase();
  }

  public void onCreate(SQLiteDatabase db) {
    db.execSQL(
        "CREATE TABLE media(id TEXT PRIMARY KEY,kind TEXT,channel INTEGER,start INTEGER,duration"
            + " REAL,rel TEXT,target TEXT,bytes INTEGER,detail TEXT,event_type TEXT,category TEXT,event_start INTEGER,event_end INTEGER)");
    db.execSQL("CREATE INDEX time_idx ON media(kind,channel,start)");
    db.execSQL("CREATE INDEX event_idx ON media(kind,event_type,channel,start)");
  }

  public void onUpgrade(SQLiteDatabase db, int from, int to) {
    if (from < 2) {
      db.execSQL("ALTER TABLE media ADD COLUMN event_type TEXT");
      try (Cursor c = db.rawQuery("SELECT id,detail FROM media WHERE kind='event'", null)) {
        while (c.moveToNext()) {
          ContentValues v = new ContentValues();
          v.put("event_type", J.parse(c.getString(1)).optString("event_type"));
          db.update("media", v, "id=?", new String[] {c.getString(0)});
        }
      }
      db.execSQL("CREATE INDEX event_idx ON media(kind,event_type,channel,start)");
    }
    if (from < 3) {
      db.execSQL("ALTER TABLE media ADD COLUMN category TEXT");
      db.execSQL("ALTER TABLE media ADD COLUMN event_start INTEGER");
      db.execSQL("ALTER TABLE media ADD COLUMN event_end INTEGER");
      // 保留旧事件的时间含义，不删除历史记录或现场文件。
      try (Cursor c = db.rawQuery("SELECT id,start,duration,event_type,detail FROM media WHERE kind='event'", null)) {
        while (c.moveToNext()) {
          boolean dwell = c.getString(3).equals("dwell");
          long time = c.getLong(1);
          ContentValues v = new ContentValues();
          v.put("category", J.parse(c.getString(4)).optString("category"));
          v.put("event_start", dwell ? time - (long)(c.getDouble(2) * 1000) : time);
          v.put("event_end", dwell ? time : time + 1000);
          db.update("media", v, "id=?", new String[]{c.getString(0)});
        }
      }
    }
  }

  public Map<String, File> targets() {
    Map<String, File> result = new LinkedHashMap<>();
    result.put("internal", new File(context.getFilesDir(), "media"));
    File[] external = context.getExternalFilesDirs(null);
    for (File f : external)
      if (f != null && Environment.isExternalStorageRemovable(f))
        result.put("sd:" + volumeId(f), new File(f, "media"));
    return result;
  }

  private String volumeId(File f) {
    String[] p = f.getAbsolutePath().split("/");
    return p.length > 2 ? p[2] : "external";
  }

  public File root(String target) throws IOException {
    File root = targets().get(target);
    if (root == null) throw new IOException("录像介质已移除");
    if (!root.exists() && !root.mkdirs()) throw new IOException("无法创建录像目录");
    if (!root.canWrite()) throw new IOException("录像介质不可写");
    return root;
  }

  public JSONObject targetInfo() {
    JSONArray items = new JSONArray();
    for (Map.Entry<String, File> e : targets().entrySet()) {
      File f = e.getValue();
      boolean ok = true;
      try {
        f = root(e.getKey());
      } catch (IOException ex) {
        ok = false;
      }
      items.put(
          J.obj(
              "id",
              e.getKey(),
              "label",
              e.getKey().equals("internal") ? "内置存储" : "外置 SD 卡 " + e.getKey().substring(3),
              "available",
              ok,
              "writable",
              ok,
              "free_bytes",
              f.getUsableSpace(),
              "total_bytes",
              f.getTotalSpace()));
    }
    return J.obj(
        "selected_id", config.storage().optString("target_id", "internal"), "targets", items);
  }

  public File newFile(String target, String relative) throws IOException {
    File f = new File(root(target), relative);
    File dir = f.getParentFile();
    if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("无法创建媒体目录");
    return f;
  }

  public synchronized void finish(
      String id, int channel, long start, double duration, String rel, String target, File file) {
    if (!file.isFile() || duration <= 0) return;
    ContentValues v = new ContentValues();
    v.put("id", id);
    v.put("kind", "recording");
    v.put("channel", channel);
    v.put("start", start);
    v.put("duration", duration);
    v.put("rel", rel);
    v.put("target", target);
    v.put("bytes", file.length());
    v.put("detail", "{}");
    getWritableDatabase().insertWithOnConflict("media", null, v, SQLiteDatabase.CONFLICT_IGNORE);
    new File(file.getAbsolutePath() + ".meta").delete();
  }

  public void journal(String id, int channel, long start, String rel, String target)
      throws IOException {
    AtomicFile meta = new AtomicFile(newFile(target, rel + ".meta"));
    FileOutputStream out = null;
    try {
      out = meta.startWrite();
      out.write(
          J.obj("id", id, "channel", channel, "start", start, "rel", rel, "target", target)
              .toString()
              .getBytes(java.nio.charset.StandardCharsets.UTF_8));
      meta.finishWrite(out);
    } catch (IOException e) {
      if (out != null) meta.failWrite(out);
      throw e;
    }
  }

  public synchronized String event(int channel, long time, JSONObject detail, byte[] jpeg)
      throws IOException {
    String id = UUID.randomUUID().toString(),
        target = config.storage().optString("target_id", "internal"),
        rel = "events/ch" + channel + "/" + id + ".jpg";
    if (root(target).getUsableSpace()
        <= config.storage().optDouble("min_free_gb", 3) * 1073741824) {
      throw new IOException("事件介质空间不足");
    }
    File f = newFile(target, rel);
    try (FileOutputStream out = new FileOutputStream(f)) {
      out.write(jpeg);
    }
    ContentValues v = new ContentValues();
    v.put("id", id);
    v.put("kind", "event");
    v.put("channel", channel);
    v.put("start", time);
    v.put("duration", detail.optDouble("dwell_seconds", 0));
    v.put("rel", rel);
    v.put("target", target);
    v.put("bytes", f.length());
    v.put("detail", detail.toString());
    v.put("event_type", detail.optString("event_type"));
    boolean dwell = detail.optString("event_type").equals("dwell");
    v.put("category", detail.optString("category"));
    v.put("event_start", dwell ? time - (long)(detail.optDouble("dwell_seconds") * 1000) : time);
    v.put("event_end", dwell ? time : time + 1000);
    try {
      getWritableDatabase().insertOrThrow("media", null, v);
    } catch (RuntimeException e) {
      f.delete();
      throw e;
    }
    return id;
  }

  /** 停留达标只更新原事件，保留首次截图、时间及 ID。 */
  public synchronized boolean promoteEvent(String id, long time, double dwellSeconds) {
    try (Cursor c = getReadableDatabase().rawQuery(
        "SELECT detail FROM media WHERE id=? AND kind='event'", new String[]{id})) {
      if (!c.moveToFirst()) return true; // 已被循环清理，不重新创建事件。
      JSONObject detail = J.parse(c.getString(0));
      if (!detail.optString("category").equals("person")) return false;
      J.put(detail, "event_type", "dwell");
      J.put(detail, "dwell_reached", true);
      J.put(detail, "dwell_seconds", dwellSeconds);
      J.put(detail, "dwell_at", J.iso(time));
      ContentValues v = new ContentValues();
      v.put("detail", detail.toString()); v.put("event_type", "dwell");
      v.put("duration", dwellSeconds); v.put("event_end", time);
      return getWritableDatabase().update("media", v, "id=?", new String[]{id}) == 1;
    }
  }

  private JSONObject row(Cursor c) {
    String id = c.getString(0),
        kind = c.getString(1),
        rel = c.getString(5),
        target = c.getString(6);
    JSONObject o = J.parse(c.getString(8));
    J.put(o, "id", id);
    J.put(o, "channel_id", c.getInt(2));
    J.put(o, "created_at", J.iso(c.getLong(3)));
    J.put(o, "duration_seconds", c.getDouble(4));
    J.put(o, "size_bytes", c.getLong(7));
    J.put(o, "target_id", target);
    J.put(o, "name", new File(rel).getName());
    File r = targets().get(target);
    boolean available = r != null && new File(r, rel).isFile();
    J.put(o, "available", available);
    J.put(o, "error", available ? "" : "文件或存储介质不可用");
    J.put(o, kind.equals("recording") ? "url" : "snapshot_url", "/media/" + id);
    if (kind.equals("event")) {
      try (Cursor rec =
          getReadableDatabase()
              .rawQuery(
                  "SELECT id FROM media WHERE kind='recording' AND channel=? AND start<=? AND"
                      + " start+duration*1000>CAST(? AS INTEGER) ORDER BY start DESC LIMIT 1",
                  new String[] {"" + c.getInt(2), "" + c.getLong(3), "" + c.getLong(3)})) {
        if (rec.moveToFirst()) J.put(o, "recording_url", "/media/" + rec.getString(0));
      }
    }
    return o;
  }

  public synchronized JSONArray list(String kind, int channel, String eventType) {
    String where = "kind=?";
    ArrayList<String> args = new ArrayList<>();
    args.add(kind);
    if (channel > 0) {
      where += " AND channel=?";
      args.add("" + channel);
    }
    if (!eventType.isEmpty()) {
      where += " AND (event_type=? OR category=?)";
      args.add(eventType); args.add(eventType);
    }
    JSONArray out = new JSONArray();
    // 事件先筛选再限额，兼容不带 JSON 扩展的旧 SQLite。
    try (Cursor c =
        getReadableDatabase()
            .query(
                "media",
                null,
                where,
                args.toArray(new String[0]),
                null,
                null,
                "start DESC,id",
                "200")) {
      while (c.moveToNext() && out.length() < 200) {
        JSONObject item = row(c);
        if (eventType.isEmpty() || item.optString("event_type").equals(eventType)
            || item.optString("category").equals(eventType)) out.put(item);
      }
    }
    return out;
  }

  public synchronized JSONObject timeline(int channel, String start, String end) {
    long lo = Instant.parse(OffsetDateTime.parse(start).toInstant().toString()).toEpochMilli(),
        hi = OffsetDateTime.parse(end).toInstant().toEpochMilli();
    if (channel < 1 || channel > 5 || hi <= lo || hi - lo > 26 * 3600000L)
      throw new IllegalArgumentException("时间轴范围无效");
    JSONArray recordings = new JSONArray(), events = new JSONArray(), eventItems = new JSONArray();
    Map<String, List<long[]>> spans = new TreeMap<>();
    int rows = 0;
    try (Cursor c =
        getReadableDatabase()
            .rawQuery(
                "SELECT * FROM media WHERE channel=? AND (CASE WHEN kind='event' THEN event_start ELSE start"
                    + " END)<CAST(? AS INTEGER) AND (CASE WHEN kind='recording' THEN start+duration*1000"
                    + " ELSE event_end END)>CAST(? AS INTEGER) ORDER BY start,id",
                new String[] {"" + channel, "" + hi, "" + lo})) {
      while (c.moveToNext()) {
        if (++rows > 10000) throw new IllegalArgumentException("时间轴项目过多，请缩小范围");
        long time = c.getLong(3);
        double seconds = c.getDouble(4);
        JSONObject item = row(c);
        if (c.getString(1).equals("recording")) {
          recordings.put(item);
          continue;
        }
        String type = item.optString("event_type");
        // 随全天索引返回截图元数据，复用本次查询，不额外扫描录像或生成图片。
        eventItems.put(J.obj("id", item.optString("id"), "channel_id", channel,
            "created_at", item.optString("created_at"), "event_type", type,
            "snapshot_url", item.optString("snapshot_url")));
        long a = c.getLong(c.getColumnIndexOrThrow("event_start")),
            b = c.getLong(c.getColumnIndexOrThrow("event_end"));
        a = Math.max(a, lo);
        b = Math.min(b, hi);
        if (a < b) spans.computeIfAbsent(type, k -> new ArrayList<>()).add(new long[] {a, b});
      }
    }
    for (Map.Entry<String, List<long[]>> e : spans.entrySet()) {
      e.getValue().sort(Comparator.comparingLong(a -> a[0]));
      long[] current = null;
      for (long[] v : e.getValue()) {
        if (current != null && v[0] <= current[1]) current[1] = Math.max(current[1], v[1]);
        else {
          if (current != null)
            events.put(
                J.obj(
                    "start",
                    J.iso(current[0]),
                    "end",
                    J.iso(current[1]),
                    "event_type",
                    e.getKey()));
          current = v.clone();
        }
      }
      if (current != null)
        events.put(
            J.obj("start", J.iso(current[0]), "end", J.iso(current[1]), "event_type", e.getKey()));
    }
    return J.obj(
        "start", J.iso(lo), "end", J.iso(hi), "recordings", recordings, "event_segments", events,
        "event_items", eventItems);
  }

  public synchronized File media(String id) throws IOException {
    if (!id.matches("[A-Za-z0-9-]{1,80}")) throw new FileNotFoundException();
    try (Cursor c =
        getReadableDatabase()
            .query(
                "media",
                new String[] {"target", "rel"},
                "id=?",
                new String[] {id},
                null,
                null,
                null)) {
      if (!c.moveToFirst()) throw new FileNotFoundException();
      File root = targets().get(c.getString(0));
      if (root == null) throw new FileNotFoundException();
      File f = new File(root, c.getString(1));
      if (!f.isFile()) throw new FileNotFoundException();
      return f;
    }
  }

  public synchronized boolean cleanup() {
    String target = config.storage().optString("target_id", "internal");
    File root;
    try {
      root = root(target);
    } catch (IOException e) {
      return false;
    }
    long used = 0;
    try (Cursor c =
        getReadableDatabase()
            .rawQuery(
                "SELECT coalesce(sum(bytes),0) FROM media WHERE target=?", new String[] {target})) {
      if (c.moveToFirst()) used = c.getLong(0);
    }
    used += pendingBytes(root);
    long maximum = (long) (config.storage().optDouble("max_gb", 24) * 1073741824),
        reserve = (long) (config.storage().optDouble("min_free_gb", 3) * 1073741824);
    if (used <= maximum && root.getUsableSpace() > reserve) return true;
    try (Cursor c =
        getReadableDatabase()
            .rawQuery(
                "SELECT id,rel,bytes FROM media WHERE target=? ORDER BY start",
                new String[] {target})) {
      while (c.moveToNext() && (used > maximum || root.getUsableSpace() <= reserve)) {
        File f = new File(root, c.getString(1));
        if (f.exists() && !f.delete()) continue;
        used -= c.getLong(2);
        getWritableDatabase().delete("media", "id=?", new String[] {c.getString(0)});
      }
    }
    return root.getUsableSpace() > reserve && used <= maximum;
  }

  private long pendingBytes(File root) {
    long bytes = 0;
    for (int channel = 1; channel <= 5; channel++) {
      File[] files = new File(root, "recordings/ch" + channel).listFiles();
      if (files == null) continue;
      for (File f : files) if (f.getName().endsWith(".mp4.part")) bytes += f.length();
    }
    return bytes;
  }

  /** 仅在旧采集器完全退出后调用，清除异常断电留下的未封装片段。 */
  public synchronized void recover() {
    int removed = 0;
    for (File root : targets().values()) {
      for (int channel = 1; channel <= 5; channel++) {
        File[] files = new File(root, "recordings/ch" + channel).listFiles();
        if (files == null) continue;
        for (File f : files) {
          if (f.getName().matches("[0-9a-f-]{36}\\.mp4\\.part") && f.delete()) removed++;
          if (f.getName().matches("[0-9a-f-]{36}\\.mp4\\.meta")) {
            try (InputStream in = new FileInputStream(f)) {
              JSONObject meta = J.parse(J.text(in, 4096));
              File video =
                  new File(f.getAbsolutePath().substring(0, f.getAbsolutePath().length() - 5));
              String id = meta.optString("id"), rel = "recordings/ch" + channel + "/" + id + ".mp4";
              if (!video.getName().equals(id + ".mp4") || !rel.equals(meta.optString("rel")))
                continue;
              if (!video.isFile()) {
                f.delete();
                continue;
              }
              MediaMetadataRetriever reader = new MediaMetadataRetriever();
              try {
                reader.setDataSource(video.getAbsolutePath());
                double seconds =
                    Double.parseDouble(
                            reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION))
                        / 1000;
                finish(
                    id,
                    channel,
                    meta.optLong("start"),
                    seconds,
                    rel,
                    meta.optString("target"),
                    video);
                Logs.info("恢复已封装片段的索引 ch" + channel);
              } finally {
                reader.release();
              }
            } catch (Exception e) {
              Logs.error("恢复片段索引", e);
            }
          }
        }
      }
    }
    if (removed > 0) Logs.info("清理异常退出遗留的未封装片段：" + removed);
  }
}
