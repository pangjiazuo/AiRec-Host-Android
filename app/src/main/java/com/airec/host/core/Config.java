package com.airec.host.core;

import android.content.Context;
import android.util.AtomicFile;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.json.*;

public final class Config {
  private volatile JSONObject current;
  private final AtomicFile file;

  public Config(Context c) throws IOException {
    file = new AtomicFile(new File(c.getFilesDir(), "settings.json"));
    try (InputStream in = file.openRead()) {
      current = validate(J.parse(J.text(in, 65536)));
    } catch (Exception e) {
      try (InputStream in = c.getAssets().open("defaults.json")) {
        current = validate(J.parse(J.text(in, 65536)));
      }
    }
  }

  public JSONObject get() {
    return J.copy(current);
  }

  // 发布完整不可变配置，采集线程只读取，不修改。
  public JSONObject channel(int id) {
    return current.optJSONArray("channels").optJSONObject(id - 1);
  }

  public JSONObject storage() {
    return current.optJSONObject("storage");
  }

  public synchronized void save(JSONObject input) throws IOException {
    JSONObject value = validate(J.copy(input));
    FileOutputStream out = null;
    try {
      out = file.startWrite();
      out.write(value.toString().getBytes(StandardCharsets.UTF_8));
      file.finishWrite(out);
      for (int id = 1; id <= 5; id++) {
        JSONObject before = channel(id).optJSONObject("privacy");
        JSONObject after = value.optJSONArray("channels").optJSONObject(id - 1).optJSONObject("privacy");
        if (!after.toString().equals(before.toString())) Logs.info("隐私设置 ch" + id
            + " 人脸=" + after.optBoolean("face_mosaic") + " 车牌=" + after.optBoolean("plate_mosaic"));
      }
      current = value;
    } catch (IOException e) {
      if (out != null) file.failWrite(out);
      throw e;
    }
  }

  public static JSONObject validate(JSONObject o) {
    JSONArray a = o.optJSONArray("channels");
    if (a == null || a.length() != 5) throw new IllegalArgumentException("需要五路完整配置");
    for (int i = 0; i < 5; i++) {
      JSONObject c = a.optJSONObject(i);
      if (c == null || c.optInt("id") != i + 1) throw new IllegalArgumentException("通道顺序必须为 1～5");
      if (c.optString("name").trim().isEmpty() || c.optString("name").length() > 80)
        throw new IllegalArgumentException("通道名称无效");
      if (!(c.opt("enabled") instanceof Boolean)) throw new IllegalArgumentException("通道开关无效");
      // 本板两路物理源固定，防止网页任意改接线映射。
      if (!c.optString("source").equals(i == 0 ? "/dev/video5" : "/dev/video0"))
        throw new IllegalArgumentException("采集源不匹配本板");
      JSONArray crop = c.optJSONArray("crop");
      if (crop == null || crop.length() != 4) throw new IllegalArgumentException("画面区域无效");
      double x = crop.optDouble(0, -1),
          y = crop.optDouble(1, -1),
          w = crop.optDouble(2, -1),
          h = crop.optDouble(3, -1);
      if (i == 0) {
        if (x != 0 || y != 0 || w != 1 || h != 1) throw new IllegalArgumentException("AHD1 使用完整画面");
      } else if ((x != 0 && x != .5) || (y != 0 && y != .5) || w != .5 || h != .5)
        throw new IllegalArgumentException("AHD2～5 请选择四宫格区域");
      range(c, "width", 160, 1280);
      range(c, "height", 120, 720);
      range(c, "fps", 1, 30);
      range(c, "preview_fps", 1, 30);
      if (c.optInt("width") % 16 != 0 || c.optInt("height") % 8 != 0)
        throw new IllegalArgumentException("宽度须为16的倍数，高度须为8的倍数");
      JSONObject privacy = c.optJSONObject("privacy");
      if (privacy == null && c.has("privacy")) throw new IllegalArgumentException("隐私配置无效");
      if (privacy == null) { privacy = J.obj("face_mosaic", false, "plate_mosaic", false); J.put(c, "privacy", privacy); }
      for (String key : new String[]{"face_mosaic", "plate_mosaic"})
        if (!(privacy.opt(key) instanceof Boolean)) throw new IllegalArgumentException("隐私开关无效");
      JSONObject r = c.optJSONObject("recording"), d = c.optJSONObject("detection");
      if (r == null
          || d == null
          || !Arrays.asList(1, 3, 5, 10).contains(r.optInt("segment_minutes")))
        throw new IllegalArgumentException("录像片段仅支持1/3/5/10分钟");
      if (!(r.opt("enabled") instanceof Boolean) || !(d.opt("enabled") instanceof Boolean))
        throw new IllegalArgumentException("录像或检测开关无效");
      range(d, "confidence", .01, 1);
      range(d, "threshold_seconds", .1, 3600);
      range(d, "sample_interval", .1, 60);
      range(d, "lost_tolerance_seconds", .1, 60);
      JSONArray categories = d.optJSONArray("categories");
      if (categories == null) throw new IllegalArgumentException("缺少识别类别");
      for (int n = 0; n < categories.length(); n++)
        if (!Arrays.asList("person", "vehicle", "animal").contains(categories.optString(n)))
          throw new IllegalArgumentException("识别类别无效");
    }
    JSONObject s = o.optJSONObject("storage");
    if (s == null) throw new IllegalArgumentException("缺少存储设置");
    range(s, "max_gb", 1, 100000);
    range(s, "min_free_gb", .1, 100000);
    JSONObject server = o.optJSONObject("server");
    if (server == null || server.optInt("port") != 8080)
      throw new IllegalArgumentException("当前局域网端口固定为8080");
    return o;
  }

  private static void range(JSONObject o, String key, double min, double max) {
    double n = o.optDouble(key, Double.NaN);
    if (!Double.isFinite(n) || n < min || n > max)
      throw new IllegalArgumentException(key + " 超出范围");
  }
}
