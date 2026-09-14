package com.airec.host.capture;

import android.content.Context;
import android.graphics.*;
import android.opengl.*;
import android.os.*;
import com.airec.host.core.*;
import com.airec.host.storage.Store;
import java.io.*;
import java.nio.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.*;

/** 两组 V4L2 输入在 GPU 上裁成五路，录像不经过 CPU 全帧转换。 */
public final class Capture implements AutoCloseable {
  private static final HandlerThread thread = new HandlerThread("camera-gl");

  static {
    thread.start();
  }

  private final Handler handler;
  private final Context context;
  private final Config config;
  private final Store store;
  private final Channel[] channels;
  private volatile boolean closed;
  public volatile boolean storageReady = true;
  private EGLDisplay display;
  private EGLContext egl;
  private EGLConfig eglConfig;
  private EGLSurface offscreen;
  private EGLSurface boundSurface;
  private int program, position, texcoord, matrix, crop, sourceWidth;
  private FloatBuffer vertices, coords;
  private final Source[] sources = new Source[2];
  private final SegmentEncoder[] encoders = new SegmentEncoder[5];
  private final EGLSurface[] windows = new EGLSurface[5];
  private final String[] signatures = new String[5];
  private final android.view.Surface[] localSurfaces = new android.view.Surface[5];
  private final EGLSurface[] localWindows = new EGLSurface[5];
  private final int[] localWidths = new int[5], localHeights = new int[5], localCounts = new int[5];
  private final long[] nextLocal = new long[5], localRateAt = new long[5];

  /** 本机直接显示 GPU 图像，不经过 JPEG 和 HTTP。Surface 由界面持有。 */
  public void localPreview(int index, android.view.Surface surface, int width, int height) {
    if (index < 0 || index >= 5 || closed) return;
    handler.post(() -> {
      if (closed) return;
      if (localSurfaces[index] != surface) {
        current(offscreen);
        if (localWindows[index] != null) EGL14.eglDestroySurface(display, localWindows[index]);
        localWindows[index] = null;
        localSurfaces[index] = surface;
        channels[index].localPreviewFps = 0;
        localCounts[index] = 0; localRateAt[index] = 0; nextLocal[index] = 0;
        if (surface != null && surface.isValid()) {
          EGLSurface window = EGL14.eglCreateWindowSurface(display, eglConfig, surface, new int[]{EGL14.EGL_NONE}, 0);
          if (window != EGL14.EGL_NO_SURFACE) localWindows[index] = window;
          else Logs.info("本机预览表面创建失败 ch" + (index + 1));
        }
      }
      localWidths[index] = width;
      localHeights[index] = height;
    });
  }

  public void releaseLocalPreview(int index) {
    if (closed) return;
    localPreview(index, null, 0, 0);
    CountDownLatch detached = new CountDownLatch(1);
    handler.post(detached::countDown);
    try {
      if (!detached.await(1, TimeUnit.SECONDS)) Logs.info("本机预览表面释放超时 ch" + (index + 1));
    } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
  }
  private final long[] nextPreview = new long[5], nextEncode = new long[5], nextRetry = new long[5];
  private final int[] counts = new int[5];
  private final long[] countAt = new long[5];
  private final ExecutorService previews = Executors.newFixedThreadPool(2);
  private final Preview[] previewTasks = {
    new Preview(), new Preview(), new Preview(), new Preview(), new Preview()
  };

  private final class Preview {
    final AtomicBoolean busy = new AtomicBoolean();
    final ByteBuffer pixels =
        ByteBuffer.allocateDirect(640 * 360 * 4).order(ByteOrder.nativeOrder());
    final Bitmap bitmap = Bitmap.createBitmap(640, 360, Bitmap.Config.ARGB_8888);
    final Bitmap probe = Bitmap.createBitmap(64, 36, Bitmap.Config.ARGB_8888);
    boolean probing;
    long rateAt;
    int published;

    void process(int i) {
      try {
        pixels.rewind();
        Bitmap image = probing ? probe : bitmap;
        image.copyPixelsFromBuffer(pixels);
        Channel ch = channels[i];
        boolean missing = Signal.missing(image);
        ch.noSignal = missing;
        if (!missing && config.channel(i + 1).optBoolean("enabled")) {
          ByteArrayOutputStream out = new ByteArrayOutputStream(48000);
          image.compress(Bitmap.CompressFormat.JPEG, 75, out);
          ch.publish(out.toByteArray());
          long now = SystemClock.elapsedRealtime();
          published++;
          if (rateAt == 0) rateAt = now;
          if (now - rateAt >= 1000) {
            ch.jpegFps = published * 1000.0 / (now - rateAt);
            if (ch.viewers.get() > 0 || localWindows[i] == null)
              ch.previewFps = published * 1000.0 / (now - rateAt);
            rateAt = now;
            published = 0;
          }
        } else {
          ch.jpeg = null;
          ch.detections = new JSONArray();
          ch.previewFps = 0;
          ch.jpegFps = 0;
        }
      } catch (Exception e) {
        Logs.error("生成预览", e);
      } finally {
        busy.set(false);
      }
    }
  }

  public Capture(Context context, Config config, Store store, Channel[] channels) {
    this.context = context;
    this.config = config;
    this.store = store;
    this.channels = channels;
    handler = new Handler(thread.getLooper());
    handler.post(
        () -> {
          try {
            store.recover();
            initGl();
            sources[0] = new Source("0", 2560, 1440, new int[] {1, 2, 3, 4});
            sources[1] = new Source("1", 1280, 720, new int[] {0});
            for (Source s : sources) s.open();
            pollFrames();
          } catch (Exception e) {
            Logs.error("采集初始化", e);
            for (Channel c : channels) c.error = e.toString();
          }
        });
  }

  private int shader(int type, String source) {
    int s = GLES20.glCreateShader(type);
    GLES20.glShaderSource(s, source);
    GLES20.glCompileShader(s);
    int[] ok = new int[1];
    GLES20.glGetShaderiv(s, GLES20.GL_COMPILE_STATUS, ok, 0);
    if (ok[0] == 0) throw new IllegalStateException(GLES20.glGetShaderInfoLog(s));
    return s;
  }

  private void initGl() {
    display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);
    int[] version = new int[2];
    if (!EGL14.eglInitialize(display, version, 0, version, 1))
      throw new IllegalStateException("EGL init");
    EGLConfig[] configs = new EGLConfig[1];
    int[] n = new int[1];
    EGL14.eglChooseConfig(
        display,
        new int[] {
          EGL14.EGL_RED_SIZE,
          8,
          EGL14.EGL_GREEN_SIZE,
          8,
          EGL14.EGL_BLUE_SIZE,
          8,
          EGL14.EGL_ALPHA_SIZE,
          8,
          EGL14.EGL_RENDERABLE_TYPE,
          EGL14.EGL_OPENGL_ES2_BIT,
          EGL14.EGL_SURFACE_TYPE,
          EGL14.EGL_WINDOW_BIT | EGL14.EGL_PBUFFER_BIT,
          0x3142,
          1,
          EGL14.EGL_NONE
        },
        0,
        configs,
        0,
        1,
        n,
        0);
    if (n[0] == 0) throw new IllegalStateException("无录制 EGL 配置");
    eglConfig = configs[0];
    egl =
        EGL14.eglCreateContext(
            display,
            eglConfig,
            EGL14.EGL_NO_CONTEXT,
            new int[] {EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE},
            0);
    offscreen =
        EGL14.eglCreatePbufferSurface(
            display,
            eglConfig,
            new int[] {EGL14.EGL_WIDTH, 640, EGL14.EGL_HEIGHT, 360, EGL14.EGL_NONE},
            0);
    current(offscreen);
    program = GLES20.glCreateProgram();
    GLES20.glAttachShader(
        program,
        shader(
            GLES20.GL_VERTEX_SHADER,
            "attribute vec2 p;attribute vec2 t;uniform mat4 m;uniform vec4 c;varying vec2 uv;void"
                + " main(){gl_Position=vec4(p,0.,1.);uv=(m*vec4(c.xy+t*c.zw,0.,1.)).xy;}"));
    GLES20.glAttachShader(
        program,
        shader(
            GLES20.GL_FRAGMENT_SHADER,
            "precision highp float;uniform sampler2D image;uniform float sourceWidth;varying vec2"
                + " uv;void main(){float x=min(sourceWidth-1.,floor(uv.x*sourceWidth));vec4"
                + " pair=texture2D(image,vec2((floor(x/2.)+.5)/(sourceWidth/2.),uv.y));float"
                + " y=(mod(x,2.)<1.?pair.r:pair.b)-.062745;float u=pair.g-.501961;float"
                + " v=pair.a-.501961;gl_FragColor=vec4(1.164*y+1.596*v,1.164*y-.392*u-.813*v,1.164*y+2.017*u,1.);}"));
    GLES20.glLinkProgram(program);
    sourceWidth = GLES20.glGetUniformLocation(program, "sourceWidth");
    position = GLES20.glGetAttribLocation(program, "p");
    texcoord = GLES20.glGetAttribLocation(program, "t");
    matrix = GLES20.glGetUniformLocation(program, "m");
    crop = GLES20.glGetUniformLocation(program, "c");
    vertices = buffer(new float[] {-1, -1, 1, -1, -1, 1, 1, 1});
    coords = buffer(new float[] {0, 0, 1, 0, 0, 1, 1, 1});
  }

  private FloatBuffer buffer(float[] values) {
    FloatBuffer b =
        ByteBuffer.allocateDirect(values.length * 4).order(ByteOrder.nativeOrder()).asFloatBuffer();
    b.put(values).position(0);
    return b;
  }

  private void current(EGLSurface surface) {
    if (surface == boundSurface) return;
    if (!EGL14.eglMakeCurrent(display, surface, surface, egl))
      throw new IllegalStateException("EGL current " + EGL14.eglGetError());
    boundSurface = surface;
  }

  private void draw(Source source, int index, int width, int height, boolean readback) {
    GLES20.glViewport(0, 0, width, height);
    GLES20.glUseProgram(program);
    GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
    GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, source.texture);
    GLES20.glUniform1f(sourceWidth, source.textureWidth);
    GLES20.glEnableVertexAttribArray(position);
    GLES20.glVertexAttribPointer(position, 2, GLES20.GL_FLOAT, false, 0, vertices);
    // readPixels 的第一行是画面底部，反转坐标后 Bitmap 才是正常方向。
    coords.put(0, 0);
    coords.put(1, readback ? 0 : 1);
    coords.put(2, 1);
    coords.put(3, readback ? 0 : 1);
    coords.put(4, 0);
    coords.put(5, readback ? 1 : 0);
    coords.put(6, 1);
    coords.put(7, readback ? 1 : 0);
    GLES20.glEnableVertexAttribArray(texcoord);
    GLES20.glVertexAttribPointer(texcoord, 2, GLES20.GL_FLOAT, false, 0, coords);
    GLES20.glUniformMatrix4fv(matrix, 1, false, source.transform, 0);
    JSONArray region = config.channel(index + 1).optJSONArray("crop");
    GLES20.glUniform4f(
        crop,
        (float) region.optDouble(0),
        (float) region.optDouble(1),
        (float) region.optDouble(2),
        (float) region.optDouble(3));
    GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
  }

  private void frame(Source source) {
    if (closed) return;
    try {
      current(offscreen);
      long now = SystemClock.elapsedRealtime();
      boolean allFive = true;
      for (Channel channel : channels) {
        JSONObject setting = config.channel(channel.id);
        allFive &=
            setting.optBoolean("enabled")
                && !channel.noSignal
                && setting.optJSONObject("recording").optBoolean("enabled");
      }
      // 五路都录制时优先给 AHD1～4 硬件名额，AHD5 使用软件编码。
      if (allFive && encoders[4] != null && channels[4].backend.startsWith("rockchip")) {
        stopEncoder(4);
        Arrays.fill(nextRetry, 0);
      }
      for (int i : source.indices) {
        Channel ch = channels[i];
        JSONObject c = config.channel(i + 1);
        if (!c.optBoolean("enabled")) {
          stopEncoder(i);
          ch.jpeg = null;
          ch.detections = new JSONArray();
          continue;
        }
        ch.lastFrame = now;
        counts[i]++;
        if (countAt[i] == 0) countAt[i] = now;
        if (now - countAt[i] >= 1000) {
          ch.captureFps = counts[i] * 1000.0 / (now - countAt[i]);
          counts[i] = 0;
          countAt[i] = now;
        }
        if (now >= nextPreview[i] && previewTasks[i].busy.compareAndSet(false, true)) {
          Preview task = previewTasks[i];
          current(offscreen);
          task.probing = ch.noSignal;
          int previewWidth = task.probing ? 64 : 640, previewHeight = task.probing ? 36 : 360;
          draw(source, i, previewWidth, previewHeight, true);
          task.pixels.clear();
          GLES20.glReadPixels(0, 0, previewWidth, previewHeight, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, task.pixels);
          previews.execute(() -> task.process(ch.id - 1));
          // 没有网络观看者时，只为信号检查、识别和事件截图生成低频 JPEG。
          JSONObject detection = c.optJSONObject("detection");
          long analysisPeriod = detection.optBoolean("enabled")
              ? Math.max(33, Math.min(500, (long)(detection.optDouble("sample_interval", 1) * 500))) : 500;
          long period = ch.noSignal ? 1000 : ch.viewers.get() > 0
              ? Math.max(1, 1000 / c.optInt("preview_fps", 16)) : analysisPeriod;
          nextPreview[i] = Math.max(nextPreview[i] + period, now + 1);
        }
        if (!ch.noSignal && localWindows[i] != null && now >= nextLocal[i]) {
          current(localWindows[i]);
          draw(source, i, localWidths[i], localHeights[i], false);
          if (!EGL14.eglSwapBuffers(display, localWindows[i])) {
            EGL14.eglDestroySurface(display, localWindows[i]);
            localWindows[i] = null;
          } else {
            localCounts[i]++;
            if (localRateAt[i] == 0) localRateAt[i] = now;
            if (now - localRateAt[i] >= 1000) {
              ch.previewFps = localCounts[i] * 1000.0 / (now - localRateAt[i]);
              ch.localPreviewFps = ch.previewFps;
              localCounts[i] = 0; localRateAt[i] = now;
            }
          }
          nextLocal[i] = Math.max(nextLocal[i] + Math.max(1, 1000 / c.optInt("preview_fps", 16)), now + 1);
        }
        JSONObject rec = c.optJSONObject("recording");
        boolean wanted = !ch.noSignal && storageReady && rec.optBoolean("enabled");
        boolean software = i == 4 && allFive;
        String signature =
            config.storage().optString("target_id")
                + ":"
                + c.optInt("width")
                + ":"
                + c.optInt("height")
                + ":"
                + c.optInt("fps")
                + ":"
                + rec.optInt("segment_minutes")
                + ":"
                + c.optJSONArray("crop")
                + ":"
                + software;
        if (encoders[i] != null
            && (!wanted || !signature.equals(signatures[i]) || !encoders[i].healthy()))
          stopEncoder(i);
        if (wanted && encoders[i] == null && now >= nextRetry[i]) {
          try {
            encoders[i] =
                new SegmentEncoder(
                    ch,
                    store,
                    config.storage().optString("target_id", "internal"),
                    c.optInt("width"),
                    c.optInt("height"),
                    c.optInt("fps"),
                    rec.optInt("segment_minutes"),
                    software);
            windows[i] =
                EGL14.eglCreateWindowSurface(
                    display, eglConfig, encoders[i].surface, new int[] {EGL14.EGL_NONE}, 0);
            if (windows[i] == EGL14.EGL_NO_SURFACE) throw new IllegalStateException("EGL 录像表面失败");
            signatures[i] = signature;
            ch.error = "";
            Logs.info("录像启动 ch" + ch.id + " " + ch.backend);
          } catch (Exception e) {
            stopEncoder(i);
            ch.error = e.getMessage();
            nextRetry[i] = now + 10000;
            Logs.error("启动录像 ch" + ch.id, e);
          }
        }
        if (encoders[i] != null && now + 10 >= nextEncode[i]) {
          current(windows[i]);
          draw(source, i, c.optInt("width"), c.optInt("height"), false);
          EGLExt.eglPresentationTimeANDROID(display, windows[i], System.nanoTime());
          if (!EGL14.eglSwapBuffers(display, windows[i]))
            throw new IllegalStateException("录像 EGL swap");
          nextEncode[i] = Math.max(nextEncode[i] + Math.max(1, 1000 / c.optInt("fps")), now + 1);
        }
      }
    } catch (Exception e) {
      Logs.error("视频帧", e);
    } finally {
      if (display != null) current(offscreen);
    }
  }

  private void stopEncoder(int index) {
    if (encoders[index] != null) {
      current(offscreen);
      if (windows[index] != null) {
        EGL14.eglDestroySurface(display, windows[index]);
        windows[index] = null;
      }
      encoders[index].close();
      encoders[index] = null;
    }
  }

  private void pollFrames() {
    if (closed) return;
    long now = SystemClock.elapsedRealtime();
    for (Source s : sources)
      if (s != null && s.handle != 0 && now >= s.nextPoll) {
        try {
          boolean live = false;
          for (int i : s.indices)
            if (config.channel(i + 1).optBoolean("enabled") && !channels[i].noSignal) live = true;
          current(offscreen);
          s.texture = s.textures[s.textureSlot];
          boolean updated = NativeVideo.update(s.handle, s.texture, !live);
          if (updated) {
            s.textureWidth = live ? s.width : 256;
            frame(s);
            String transport = "gpu-texture-upload";
            for (int i : s.indices) {
              if (!transport.equals(channels[i].captureBackend)) Logs.info("采集传输 ch" + (i + 1) + " " + transport);
              channels[i].captureBackend = transport;
            }
            s.textureSlot = (s.textureSlot + 1) % s.textures.length;
          }
          // 新帧之后稍等再查询，避免每几毫秒反复切换 GL 上下文和空取帧。
          s.nextPoll = now + (live ? updated ? 24 : 4 : 500);
        } catch (Exception e) {
          s.failed(e.toString());
        }
      }
    long delay = 100;
    for (Source s : sources) if (s != null && s.handle != 0)
      delay = Math.min(delay, Math.max(1, s.nextPoll - SystemClock.elapsedRealtime()));
    handler.postDelayed(this::pollFrames, delay);
  }

  private final class Source {
    final String id;
    final int width, height;
    final int[] indices;
    final float[] transform = new float[16];
    int texture, textureWidth = 256;
    final int[] textures = new int[3];
    int textureSlot;
    long handle, nextPoll;

    Source(String id, int width, int height, int[] indices) {
      this.id = id;
      this.width = width;
      this.height = height;
      this.indices = indices;
      android.opengl.Matrix.setIdentityM(transform, 0);
      // 轮换纹理，避免上传新帧时等待上一帧的 GPU 读取结束。
      GLES20.glGenTextures(textures.length, textures, 0);
      for (int texture : textures) {
      GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texture);
      GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_NEAREST);
      GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_NEAREST);
      GLES20.glTexParameteri(
          GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
      GLES20.glTexParameteri(
          GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);
      GLES20.glTexImage2D(
          GLES20.GL_TEXTURE_2D,
          0,
          GLES20.GL_RGBA,
          width / 2,
          height,
          0,
          GLES20.GL_RGBA,
          GLES20.GL_UNSIGNED_BYTE,
          null);
      }
      texture = textures[0];
    }

    void open() {
      if (closed || handle != 0) return;
      try {
        String name = "airec-" + UUID.randomUUID();
        int server = NativeVideo.listen(name);
        String helper = context.getApplicationInfo().nativeLibraryDir + "/libairec_fd.so";
        String device = id.equals("0") ? "/dev/video0" : "/dev/video5";
        java.lang.Process process =
            new ProcessBuilder("su", "0", helper, name, device).redirectErrorStream(true).start();
        try {
          handle = NativeVideo.accept(server, width, height);
        } finally {
          process.destroy();
        }
        for (int i : indices) channels[i].error = "";
        Logs.info("V4L2 " + device + " " + width + "x" + height + " 已打开");
      } catch (Exception e) {
        failed(e.toString());
      }
    }

    void failed(String error) {
      Logs.info("AHD " + id + "：" + error);
      for (int i : indices) {
        channels[i].error = error;
        channels[i].noSignal = true;
        channels[i].jpeg = null;
        stopEncoder(i);
      }
      if (handle != 0) {
        NativeVideo.close(handle);
        handle = 0;
      }
      if (!error.contains("启动 AHD 采集失败")) handler.postDelayed(this::open, 10000);
    }

    void release() {
      if (handle != 0) NativeVideo.close(handle);
      handle = 0;
      GLES20.glDeleteTextures(textures.length, textures, 0);
    }
  }

  public void close() {
    closed = true;
    handler.post(
        () -> {
          try {
            for (int i = 0; i < 5; i++) stopEncoder(i);
            for (int i = 0; i < 5; i++) if (localWindows[i] != null) {
              EGL14.eglDestroySurface(display, localWindows[i]); localWindows[i] = null;
            }
            for (Source s : sources) if (s != null) s.release();
            previews.shutdown();
            if (display != null) {
              EGL14.eglMakeCurrent(
                  display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT);
              EGL14.eglDestroySurface(display, offscreen);
              EGL14.eglDestroyContext(display, egl);
              EGL14.eglTerminate(display);
            }
          } finally {
            Logs.info("采集与片段封装已停止");
          }
        });
  }
}
