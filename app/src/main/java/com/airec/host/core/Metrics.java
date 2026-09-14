package com.airec.host.core;

import android.app.ActivityManager;
import android.content.Context;
import android.os.*;
import java.io.*;
import org.json.*;

public final class Metrics {
  private final Context context;
  private long lastCpu, lastWall;
  private long lastTotal, lastIdle;
  private volatile JSONObject value = new JSONObject();

  public Metrics(Context c) {
    context = c;
  }

  public JSONObject get() {
    return value;
  }

  public void update() {
    ActivityManager.MemoryInfo m = new ActivityManager.MemoryInfo();
    ((ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE)).getMemoryInfo(m);
    long cpu = android.os.Process.getElapsedCpuTime(), wall = SystemClock.elapsedRealtime();
    double percent =
        lastWall == 0
            ? 0
            : 100.0
                * (cpu - lastCpu)
                / Math.max(1, wall - lastWall)
                / Runtime.getRuntime().availableProcessors();
    lastCpu = cpu;
    lastWall = wall;
    String scope = "recorder_process";
    try (BufferedReader r = new BufferedReader(new FileReader("/proc/stat"))) {
      String[] fields = r.readLine().trim().split("\\s+");
      long total = 0;
      for (int i = 1; i <= 8 && i < fields.length; i++) total += Long.parseLong(fields[i]);
      long idle = Long.parseLong(fields[4]) + Long.parseLong(fields[5]);
      percent =
          lastTotal > 0 && total > lastTotal
              ? 100.0 * (1 - (double) (idle - lastIdle) / (total - lastTotal))
              : 0;
      lastTotal = total;
      lastIdle = idle;
      scope = "system";
    } catch (Exception ignored) {
    }
    Object temp = JSONObject.NULL;
    File[] zones = new File("/sys/class/thermal").listFiles();
    if (zones != null)
      for (File f : zones)
        if (f.getName().startsWith("thermal_zone")) {
          try (BufferedReader r = new BufferedReader(new FileReader(new File(f, "temp")))) {
            double t = Double.parseDouble(r.readLine().trim());
            if (t > 1000) t /= 1000;
            if (t > 0 && t < 130) {
              temp = t;
              break;
            }
          } catch (Exception ignored) {
          }
        }
    value =
        J.obj(
            "hostname",
            Build.MODEL,
            "os",
            "Android " + Build.VERSION.RELEASE,
            "cpu_percent",
            percent,
            "cpu_scope",
            scope,
            "temperature_c",
            temp,
            "memory",
            J.obj(
                "total_bytes",
                m.totalMem,
                "available_bytes",
                m.availMem,
                "used_bytes",
                m.totalMem - m.availMem,
                "used_percent",
                100.0 * (m.totalMem - m.availMem) / m.totalMem));
  }
}
