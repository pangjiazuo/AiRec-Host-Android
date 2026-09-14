package com.airec.host.core;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import org.json.*;

public final class J {
  public static JSONObject obj(Object... pairs) {
    JSONObject o = new JSONObject();
    for (int i = 0; i < pairs.length; i += 2) put(o, pairs[i].toString(), pairs[i + 1]);
    return o;
  }

  public static void put(JSONObject o, String k, Object v) {
    try {
      o.put(k, v == null ? JSONObject.NULL : v);
    } catch (JSONException e) {
      throw new IllegalArgumentException(e);
    }
  }

  public static JSONObject parse(String s) {
    try {
      return new JSONObject(s);
    } catch (JSONException e) {
      throw new IllegalArgumentException("JSON 格式无效", e);
    }
  }

  public static JSONObject copy(JSONObject o) {
    return parse(o.toString());
  }

  public static String iso(long millis) {
    return Instant.ofEpochMilli(millis).toString();
  }

  public static byte[] read(InputStream in, int limit) throws IOException {
    ByteArrayOutputStream b = new ByteArrayOutputStream();
    byte[] buf = new byte[16384];
    int n;
    while ((n = in.read(buf)) != -1) {
      if (b.size() + n > limit) throw new IOException("文件过大");
      b.write(buf, 0, n);
    }
    return b.toByteArray();
  }

  public static String text(InputStream in, int limit) throws IOException {
    return new String(read(in, limit), StandardCharsets.UTF_8);
  }
}
