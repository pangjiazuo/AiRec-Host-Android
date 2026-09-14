package com.airec.host.detection;

import android.graphics.Bitmap;

final class NativeDetector {
  static {
    System.loadLibrary("airec_detector");
  }

  static native long open(String path);

  static native String version(long handle);

  static native float[] run(long handle, Bitmap bitmap, float threshold);

  static native void close(long handle);
}
