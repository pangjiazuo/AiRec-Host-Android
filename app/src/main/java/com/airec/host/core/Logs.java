package com.airec.host.core;

import android.util.Log;
import java.io.*;

public final class Logs {
  private static File root;

  public static synchronized void init(File dir) {
    root = dir;
    dir.mkdirs();
  }

  public static synchronized void info(String text) {
    Log.i("AiRecHost", text);
    if (root == null) return;
    try {
      File f = new File(root, "host.log");
      if (f.length() > 1024 * 1024) {
        File old = new File(root, "host.previous.log");
        if (old.exists()) old.delete();
        f.renameTo(old);
      }
      try (FileWriter w = new FileWriter(f, true)) {
        w.write(J.iso(System.currentTimeMillis()) + " " + text + "\n");
      }
    } catch (IOException ignored) {
    }
  }

  public static void error(String where, Throwable e) {
    info(where + ": " + Log.getStackTraceString(e));
  }
}
