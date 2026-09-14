package com.airec.host;

import android.media.*;
import android.opengl.*;
import android.os.SystemClock;
import android.view.Surface;
import java.util.*;

/** 临时诊断：合成画面，不读取摄像头、不保存录像。 */
public class CodecProbe {
  static class Channel {
    MediaCodec codec;
    Surface input;
    EGLSurface egl;
    int sent, received;
    long bytes;
    boolean eos;
  }

  public static void main(String[] args) throws Exception {
    int count = args.length > 0 ? Integer.parseInt(args[0]) : 5;
    String selected = null;
    for (MediaCodecInfo info : new MediaCodecList(MediaCodecList.ALL_CODECS).getCodecInfos()) {
      if (!info.isEncoder()) continue;
      for (String type : info.getSupportedTypes()) {
        if (!type.startsWith("video/")) continue;
        MediaCodecInfo.CodecCapabilities caps = info.getCapabilitiesForType(type);
        System.out.println(
            "ENCODER "
                + info.getName()
                + " "
                + type
                + " instances="
                + caps.getMaxSupportedInstances());
        if (type.equals("video/avc") && info.getName().startsWith("OMX.rk."))
          selected = info.getName();
      }
    }
    if (selected == null) throw new Exception("No Rockchip AVC encoder");
    EGLDisplay display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);
    int[] version = new int[2];
    EGL14.eglInitialize(display, version, 0, version, 1);
    int[] attrib = {
      EGL14.EGL_RED_SIZE,
      8,
      EGL14.EGL_GREEN_SIZE,
      8,
      EGL14.EGL_BLUE_SIZE,
      8,
      EGL14.EGL_RENDERABLE_TYPE,
      EGL14.EGL_OPENGL_ES2_BIT,
      0x3142,
      1,
      EGL14.EGL_NONE
    };
    EGLConfig[] configs = new EGLConfig[1];
    int[] number = new int[1];
    if (!EGL14.eglChooseConfig(display, attrib, 0, configs, 0, 1, number, 0) || number[0] == 0)
      throw new Exception("EGL config");
    EGLContext context =
        EGL14.eglCreateContext(
            display,
            configs[0],
            EGL14.EGL_NO_CONTEXT,
            new int[] {EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE},
            0);
    List<Channel> channels = new ArrayList<>();
    try {
      for (int i = 0; i < count; i++) {
        Channel ch = new Channel();
        channels.add(ch);
        try {
          ch.codec = MediaCodec.createByCodecName(i == 4 ? "OMX.google.h264.encoder" : selected);
          MediaFormat f = MediaFormat.createVideoFormat("video/avc", 1280, 720);
          f.setInteger(
              MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
          f.setInteger(MediaFormat.KEY_BIT_RATE, 2000000);
          f.setInteger(MediaFormat.KEY_FRAME_RATE, 30);
          f.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1);
          ch.codec.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
          ch.input = ch.codec.createInputSurface();
          ch.codec.start();
          ch.egl =
              EGL14.eglCreateWindowSurface(
                  display, configs[0], ch.input, new int[] {EGL14.EGL_NONE}, 0);
          if (ch.egl == EGL14.EGL_NO_SURFACE) throw new Exception("EGL surface");
          System.out.println("STARTED channel=" + (i + 1));
        } catch (Exception e) {
          System.out.println("START_FAILED channel=" + (i + 1) + " " + e);
          throw e;
        }
      }
      long begin = System.nanoTime();
      for (int frame = 0; frame < 90; frame++) {
        long deadline = begin + frame * 1000000000L / 30;
        long wait = deadline - System.nanoTime();
        if (wait > 0) SystemClock.sleep(wait / 1000000);
        for (int i = 0; i < count; i++) {
          Channel ch = channels.get(i);
          if (!EGL14.eglMakeCurrent(display, ch.egl, ch.egl, context))
            throw new Exception("makeCurrent");
          GLES20.glViewport(0, 0, 1280, 720);
          GLES20.glClearColor((frame % 30) / 30f, i / 5f, 0.4f, 1f);
          GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT);
          EGLExt.eglPresentationTimeANDROID(display, ch.egl, frame * 1000000000L / 30);
          if (!EGL14.eglSwapBuffers(display, ch.egl)) throw new Exception("swapBuffers");
          ch.sent++;
          drain(ch);
        }
      }
      double inputSeconds = (System.nanoTime() - begin) / 1e9;
      for (Channel ch : channels) ch.codec.signalEndOfInputStream();
      long until = System.nanoTime() + 3000000000L;
      while (System.nanoTime() < until) {
        boolean done = true;
        for (Channel ch : channels) {
          drain(ch);
          done &= ch.eos;
        }
        if (done) break;
        SystemClock.sleep(5);
      }
      for (int i = 0; i < count; i++) {
        Channel ch = channels.get(i);
        if (ch.received != 90 || !ch.eos) throw new Exception("编码帧数或EOS不正确");
        System.out.println(
            "RESULT channel="
                + (i + 1)
                + " sent="
                + ch.sent
                + " output="
                + ch.received
                + " bytes="
                + ch.bytes
                + " eos="
                + ch.eos
                + " input_wall_seconds="
                + inputSeconds);
      }
    } finally {
      EGL14.eglMakeCurrent(
          display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT);
      for (Channel ch : channels) {
        if (ch.egl != null) EGL14.eglDestroySurface(display, ch.egl);
        if (ch.codec != null) {
          try {
            ch.codec.stop();
          } catch (Exception e) {
          }
          ch.codec.release();
        }
        if (ch.input != null) ch.input.release();
      }
      EGL14.eglDestroyContext(display, context);
      EGL14.eglTerminate(display);
    }
  }

  static void drain(Channel ch) {
    MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
    for (; ; ) {
      int index = ch.codec.dequeueOutputBuffer(info, 0);
      if (index == MediaCodec.INFO_TRY_AGAIN_LATER) return;
      if (index < 0) continue;
      if (info.size > 0 && (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
        ch.received++;
        ch.bytes += info.size;
      }
      ch.eos |= (info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
      ch.codec.releaseOutputBuffer(index, false);
    }
  }
}
