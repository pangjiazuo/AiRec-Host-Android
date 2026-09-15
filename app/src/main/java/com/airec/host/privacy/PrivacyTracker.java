package com.airec.host.privacy;

import android.content.Context;
import android.graphics.Bitmap;
import java.nio.*;
import java.util.*;

/** 低频定位、逐帧图像跟踪。历史小图用于把延迟到达的检测框对齐到当前帧。 */
public final class PrivacyTracker {
  public static final int WIDTH = 160, HEIGHT = 90;
  private static final int HISTORY = 32;
  private final ByteBuffer[] history = new ByteBuffer[HISTORY];
  private final ByteBuffer detectionPixels = ByteBuffer.allocateDirect(PrivacyFrame.WIDTH*PrivacyFrame.HEIGHT*4).order(ByteOrder.nativeOrder());
  private final Bitmap signalBitmap = Bitmap.createBitmap(PrivacyFrame.WIDTH,PrivacyFrame.HEIGHT,Bitmap.Config.ARGB_8888);
  private final List<Target> targets = new ArrayList<>();
  private final int flags;
  private int slot = -1;
  private long serial, nextDetection, lastSuccess, jobSerial;
  private PrivacyFrame job;
  private boolean missing = true;
  private String error = "隐私检测正在初始化";
  public double detectionMs;
  private static final class Target {
    float[] box;
    long seen;
    Target(float[] b, long t) { box = b; seen = t; }
  }
  public PrivacyTracker(int flags) {
    this.flags = flags;
    for (int n = 0; n < HISTORY; n++) history[n] = ByteBuffer.allocateDirect(WIDTH*HEIGHT*4).order(ByteOrder.nativeOrder());
  }
  public ByteBuffer beginFrame() {
    slot = (slot + 1) % HISTORY; ++serial;
    history[slot].clear(); return history[slot];
  }
  public void finishFrame(long now) {
    if (serial > 1) {
      ByteBuffer previous = history[(slot + HISTORY - 1) % HISTORY];
      for (Target target : targets) target.box = NativePrivacy.track(previous, history[slot], WIDTH, HEIGHT, target.box);
    }
    if (job != null && job.done) {
      detectionMs = job.elapsedMs; missing = job.missing;
      error = job.error;
      if (error.isEmpty()) {
        int distance = (int)(serial - jobSerial);
        if (distance >= HISTORY) error = "隐私检测结果过期，画面已遮挡";
        else {
          lastSuccess = now;
          if (missing) targets.clear();
          for (int n = 0; n < job.boxes.length; n += 4) {
            float[] box = Arrays.copyOfRange(job.boxes, n, n + 4);
            for (long seq = jobSerial + 1; seq <= serial; seq++) {
              int current = (int)((seq - 1) % HISTORY), previous = (current + HISTORY - 1) % HISTORY;
              box = NativePrivacy.track(history[previous], history[current], WIDTH, HEIGHT, box);
            }
            Target match = null; float best = .15f;
            for (Target target : targets) {
              float score = overlap(target.box, box);
              if (score > best) { best = score; match = target; }
            }
            if (match == null) targets.add(new Target(box, now));
            else { match.box = box; match.seen = now; }
          }
          if (targets.size() > 32) {
            targets.clear(); targets.add(new Target(new float[]{0,0,1,1},now));
          }
        }
      }
      job = null;
    }
  }
  public boolean shouldDetect(long now) { return job == null && now >= nextDetection; }
  public PrivacyFrame detectionFrame() {
    detectionPixels.clear(); job = new PrivacyFrame(flags,detectionPixels); jobSerial = serial;
    job.signalBitmap = signalBitmap;
    return job;
  }
  public void submit(Context context, long now, int interval) {
    nextDetection = now + interval;
    job.submit(context, () -> {});
  }
  public PrivacyFrame output(long now, long wallTime, int interval) {
    PrivacyFrame out = new PrivacyFrame(flags, null);
    out.done = true; out.missing = missing; out.mono = now; out.capturedAt = wallTime;
    out.elapsedMs = detectionMs;
    out.error = now - lastSuccess > Math.max(1500, interval*3) ? "隐私检测超时，画面已遮挡" : error;
    // 短暂漏检时保留跟踪框；下一次定位恢复后用新框纠正漂移。
    targets.removeIf(target -> now - target.seen > Math.max(800, interval*2));
    if (targets.size() > 32) out.boxes = new float[]{0,0,1,1};
    else {
      out.boxes = new float[targets.size()*4];
      for (int i=0;i<targets.size();i++) System.arraycopy(targets.get(i).box,0,out.boxes,i*4,4);
    }
    return out;
  }
  private static float overlap(float[] a, float[] b) {
    float intersection = Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0])) * Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));
    return intersection / Math.max(.00001f,(a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-intersection);
  }
}
