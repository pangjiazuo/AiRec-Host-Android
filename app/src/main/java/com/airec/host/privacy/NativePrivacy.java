package com.airec.host.privacy;

import android.content.Context;
import java.io.*;
import java.nio.ByteBuffer;

/** 专用定位模型与 YOLO/ByteTrack 解耦，关闭时不加载模型。 */
public final class NativePrivacy {
  static { System.loadLibrary("airec_privacy"); }
  private static boolean loaded;
  public static synchronized float[] detect(Context context, ByteBuffer rgba, int width, int height, int flags) throws IOException {
    if (!loaded) {
      File dir = new File(context.getFilesDir(), "privacy-models");
      if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("无法创建隐私模型目录");
      for (String name : new String[]{"face_detection.data", "carplate_detection.data"}) {
        File file = new File(dir, name);
        // APK 覆盖升级时刷新模型；只在本进程第一次启用时执行。
        try (InputStream in = context.getAssets().open("privacy/" + name); OutputStream out = new FileOutputStream(file)) {
          byte[] buffer = new byte[65536]; int n;
          while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
        }
      }
      init(dir.getAbsolutePath()); loaded = true;
    }
    rgba.rewind();
    return run(rgba, width, height, flags);
  }
  private static native void init(String path);
  private static native float[] run(ByteBuffer rgba, int width, int height, int flags);
  public static native float[] track(ByteBuffer previous, ByteBuffer current, int width, int height, float[] box);
}
