package com.airec.host;

import android.content.*;
import android.database.*;
import android.database.sqlite.*;
import com.airec.host.core.*;
import com.airec.host.storage.Store;
import java.io.*;
import java.time.Instant;
import java.util.*;
import org.json.*;

/** 所有测试文件和数据库都在 cache 下，绝不清理业务录像。 */
final class StorageChecks {
  static void run(Context base) throws Exception {
    File area = new File(base.getCacheDir(), "storage-check-" + UUID.randomUUID());
    if (!area.mkdirs()) throw new IOException("测试目录创建失败");
    Context isolated =
        new ContextWrapper(base) {
          public File getFilesDir() {
            return area;
          }

          public File[] getExternalFilesDirs(String type) {
            return new File[0];
          }

          public File getDatabasePath(String name) {
            return new File(area, name);
          }

          public SQLiteDatabase openOrCreateDatabase(
              String name, int mode, SQLiteDatabase.CursorFactory f) {
            return SQLiteDatabase.openOrCreateDatabase(getDatabasePath(name), f);
          }

          public SQLiteDatabase openOrCreateDatabase(
              String name, int mode, SQLiteDatabase.CursorFactory f, DatabaseErrorHandler handler) {
            return SQLiteDatabase.openOrCreateDatabase(getDatabasePath(name).getPath(), f, handler);
          }
        };
    Config config = new Config(isolated);
    try (Store store = new Store(isolated, config)) {
      long midnight = Instant.parse("2026-09-12T00:00:00Z").toEpochMilli();
      String before = UUID.randomUUID().toString(), inside = UUID.randomUUID().toString();
      File first = store.newFile("internal", "recordings/ch1/" + before + ".mp4");
      try (FileOutputStream out = new FileOutputStream(first)) {
        out.write(1);
      }
      store.finish(
          before, 1, midnight - 30000, 60, "recordings/ch1/" + before + ".mp4", "internal", first);
      File second = store.newFile("internal", "recordings/ch1/" + inside + ".mp4");
      try (FileOutputStream out = new FileOutputStream(second)) {
        out.write(2);
      }
      store.finish(
          inside, 1, midnight + 30000, 60, "recordings/ch1/" + inside + ".mp4", "internal", second);
      store.event(
          1,
          midnight + 10000,
          J.obj("event_type", "person", "category", "person", "dwell_seconds", 0),
          new byte[] {1});
      store.event(
          1,
          midnight + 70000,
          J.obj("event_type", "dwell", "category", "person", "dwell_seconds", 80),
          new byte[] {1});
      JSONObject timeline = store.timeline(1, J.iso(midnight), J.iso(midnight + 60000));
      require(timeline.getJSONArray("recordings").length() == 2, "跨午夜录像和窗口内录像都应返回");
      JSONArray events = timeline.getJSONArray("event_segments");
      boolean clipped = false;
      for (int i = 0; i < events.length(); i++) {
        JSONObject event = events.getJSONObject(i);
        if (event.getString("event_type").equals("dwell"))
          clipped =
              event.getString("start").equals(J.iso(midnight))
                  && event.getString("end").equals(J.iso(midnight + 60000));
      }
      require(clipped, "窗口之后触发、覆盖窗口的停留事件不能遗漏");
      require(store.list("event", 1, "person").length() == 1, "事件类别筛选");
      // 用索引中的模拟用量测试配额，磁盘上仅有几个字节。
      store
          .getWritableDatabase()
          .execSQL("UPDATE media SET bytes=800000000 WHERE kind='recording'");
      JSONObject settings = config.get();
      J.put(settings.optJSONObject("storage"), "max_gb", 1);
      J.put(settings.optJSONObject("storage"), "min_free_gb", .1);
      config.save(settings);
      File outside = new File(area, "unrelated.txt");
      try (FileOutputStream out = new FileOutputStream(outside)) {
        out.write(9);
      }
      require(store.cleanup(), "清理后恢复到配额内");
      require(!first.exists() && second.exists() && outside.exists(), "只清理最旧的应用媒体");
      require(store.list("recording", 1, "").length() == 1, "同步删除旧索引");
    } finally {
      removeTestFiles(area);
    }
  }

  private static void require(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }

  private static void removeTestFiles(File file) {
    File[] children = file.listFiles();
    if (children != null) for (File child : children) removeTestFiles(child);
    file.delete();
  }
}
