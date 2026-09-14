package com.airec.host.capture;

import android.media.*;
import android.os.SystemClock;
import android.view.Surface;
import com.airec.host.core.*;
import com.airec.host.storage.Store;
import java.io.*;
import java.nio.ByteBuffer;
import java.util.UUID;

/** 编码连续运行，在关键帧处切片，索引不包含正在写入的文件。 */
public final class SegmentEncoder implements AutoCloseable {
  public final Surface surface;
  private final MediaCodec codec;
  private final Channel channel;
  private final Store store;
  private final String target;
  private final int minutes;
  private volatile boolean running = true, stopping;
  private volatile long stopDeadline;
  private final long framePeriod;
  private final Thread drainThread;
  private MediaMuxer muxer;
  private MediaFormat format;
  private int track;
  private long firstPts, lastPts, firstWall, clockOrigin, ptsOrigin;
  private File part;
  private String id, rel;
  private int frames;
  private long fpsAt = SystemClock.elapsedRealtime();

  public SegmentEncoder(
      Channel ch,
      Store store,
      String target,
      int width,
      int height,
      int fps,
      int minutes,
      boolean software)
      throws IOException {
    this.channel = ch;
    this.store = store;
    this.target = target;
    this.minutes = minutes;
    this.framePeriod = 1000000L / fps;
    codec =
        MediaCodec.createByCodecName(
            software ? "OMX.google.h264.encoder" : "OMX.rk.video_encoder.avc");
    Surface made = null;
    try {
      MediaFormat f = MediaFormat.createVideoFormat("video/avc", width, height);
      f.setInteger(
          MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
      f.setInteger(MediaFormat.KEY_BIT_RATE, 2000000);
      f.setInteger(MediaFormat.KEY_FRAME_RATE, fps);
      f.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1);
      codec.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
      made = codec.createInputSurface();
      codec.start();
    } catch (Exception e) {
      codec.release();
      if (made != null) made.release();
      throw new IOException("编码器启动失败：" + e.getMessage(), e);
    }
    surface = made;
    ch.backend = software ? "software-h264" : "rockchip-vpu-h264";
    ch.recording = true;
    drainThread = new Thread(this::drain, "encode-" + ch.id);
    drainThread.start();
  }

  private void drain() {
    MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
    try {
      while (running && (!stopping || SystemClock.elapsedRealtime() < stopDeadline)) {
        int index = codec.dequeueOutputBuffer(info, 40000);
        if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
          format = codec.getOutputFormat();
          continue;
        }
        if (index < 0) continue;
        try {
          if (info.size > 0
              && (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0
              && format != null) {
            boolean key = (info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0;
            if (muxer != null && key && info.presentationTimeUs - firstPts >= minutes * 60000000L)
              finish(info.presentationTimeUs);
            if (muxer == null && key) begin(info.presentationTimeUs);
            if (muxer != null) {
              ByteBuffer buffer = codec.getOutputBuffer(index);
              buffer.position(info.offset);
              buffer.limit(info.offset + info.size);
              long pts = info.presentationTimeUs;
              info.presentationTimeUs = pts - firstPts;
              muxer.writeSampleData(track, buffer, info);
              lastPts = pts;
              frames++;
              long now = SystemClock.elapsedRealtime();
              if (now - fpsAt >= 1000) {
                channel.recordingFps = frames * 1000.0 / (now - fpsAt);
                frames = 0;
                fpsAt = now;
              }
            }
          }
        } finally {
          codec.releaseOutputBuffer(index, false);
        }
        if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) break;
      }
    } catch (Exception e) {
      channel.error = "录像写入失败：" + e.getMessage();
      Logs.error("encode ch" + channel.id, e);
    } finally {
      running = false;
      channel.recording = false;
      channel.recordingFps = 0;
      finish(lastPts + framePeriod);
      try {
        codec.stop();
      } catch (Exception ignored) {
      }
      codec.release();
      surface.release();
    }
  }

  private void begin(long pts) throws IOException {
    if (clockOrigin == 0
        || Math.abs(System.currentTimeMillis() - (clockOrigin + (pts - ptsOrigin) / 1000)) > 2000) {
      clockOrigin = System.currentTimeMillis();
      ptsOrigin = pts;
    }
    id = UUID.randomUUID().toString();
    rel = "recordings/ch" + channel.id + "/" + id + ".mp4";
    part = store.newFile(target, rel + ".part");
    firstPts = lastPts = pts;
    firstWall = clockOrigin + (pts - ptsOrigin) / 1000;
    store.journal(id, channel.id, firstWall, rel, target);
    muxer = new MediaMuxer(part.getAbsolutePath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
    track = muxer.addTrack(format);
    muxer.start();
  }

  private void finish(long endPts) {
    if (muxer == null) return;
    boolean ok = false;
    try {
      muxer.stop();
      ok = true;
    } catch (Exception e) {
      Logs.error("封装片段", e);
    } finally {
      muxer.release();
      muxer = null;
    }
    if (ok) {
      File finished = new File(part.getParentFile(), id + ".mp4");
      if (part.renameTo(finished)) {
        try {
          store.finish(
              id,
              channel.id,
              firstWall,
              Math.max(.001, ((clockOrigin + (endPts - ptsOrigin) / 1000) - firstWall) / 1000.0),
              rel,
              target,
              finished);
        } catch (Exception e) {
          Logs.error("片段索引", e);
        }
      }
    }
  }

  public boolean healthy() {
    return running;
  }

  public void close() {
    stopDeadline = SystemClock.elapsedRealtime() + 2000;
    stopping = true;
    try {
      codec.signalEndOfInputStream();
    } catch (Exception e) {
      running = false;
    }
    try {
      drainThread.join(2500);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
    }
    // 编码线程拥有 codec 生命周期，超时也不能由另一线程强行释放。
    if (drainThread.isAlive()) Logs.info("编码器退出超时 ch" + channel.id);
    channel.recording = false;
    channel.recordingFps = 0;
  }
}
