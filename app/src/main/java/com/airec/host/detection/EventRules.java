package com.airec.host.detection;

/** 规则与识别、数据库分开，方便验证静止/运动和停留的组合。 */
public final class EventRules {
  public enum Action { NONE, CREATE_MOTION, CREATE_DWELL, UPGRADE_DWELL }

  public static Action next(ByteTrack.Track track, double now, double confidence, double threshold) {
    if (!track.confirmed || track.box.score < confidence) return Action.NONE;
    boolean dwell = track.box.category == 0 && track.seconds(now) >= threshold;
    if (!track.presence) {
      if (dwell) return Action.CREATE_DWELL;
      if (track.motion.detected) return Action.CREATE_MOTION;
    } else if (dwell && !track.dwell) return Action.UPGRADE_DWELL;
    return Action.NONE;
  }
}
