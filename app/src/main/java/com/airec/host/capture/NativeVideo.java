package com.airec.host.capture;

final class NativeVideo {
  static {
    System.loadLibrary("airec_video");
  }

  static native int listen(String socket) throws java.io.IOException;

  static native long accept(int server, int width, int height) throws java.io.IOException;

  static native boolean update(long handle, int texture, boolean tiny) throws java.io.IOException;

  static native void close(long handle);
}
