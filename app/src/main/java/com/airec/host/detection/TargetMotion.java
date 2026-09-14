package com.airec.host.detection;

/** 复用跟踪框判断运动，不增加图像处理或 NPU 调用。 */
public final class TargetMotion {
  private final double originX, originY, originSize, distance;
  private double x, y, size;
  private int movedSamples;
  public boolean detected;

  public TargetMotion(ByteTrack.Box b) {
    originX = x = (b.x1 + b.x2) / 2;
    originY = y = (b.y1 + b.y2) / 2;
    originSize = size = Math.sqrt((b.x2-b.x1)*(b.y2-b.y1));
    distance = Math.max(.01, Math.min(b.x2-b.x1,b.y2-b.y1)*.08);
  }

  public void observe(ByteTrack.Box b) {
    if (detected) return;
    // 平滑定位抖动；连续两次越过门槛才算运动，也能累计缓慢位移。
    x = (x + (b.x1+b.x2)/2) / 2;
    y = (y + (b.y1+b.y2)/2) / 2;
    size = (size + Math.sqrt((b.x2-b.x1)*(b.y2-b.y1))) / 2;
    boolean moved = (Math.hypot(x-originX,y-originY) >= distance
        && Math.hypot((b.x1+b.x2)/2-originX,(b.y1+b.y2)/2-originY) >= distance)
        || (Math.abs(size-originSize) >= Math.max(.02,originSize*.2)
        && Math.abs(Math.sqrt((b.x2-b.x1)*(b.y2-b.y1))-originSize) >= Math.max(.02,originSize*.2));
    movedSamples = moved ? movedSamples+1 : 0;
    detected = movedSamples >= 2;
  }
}
