package com.airec.host.detection;

import static org.junit.Assert.*;
import org.junit.Test;

public class EventRulesTest {
  private ByteTrack.Box box(int category, double offset) {
    return new ByteTrack.Box(.2+offset,.2,.5+offset,.7,.8,category==0?0:category==1?2:16,category);
  }

  @Test public void stationaryAndJitteringVehiclesAndAnimalsNeverCreateEvents() {
    for (int category : new int[]{1,2}) {
      ByteTrack.Track t = new ByteTrack.Track(1,box(category,0),0);
      t.confirmed = true;
      for (int i=1; i<300; i++) {
        t.motion.observe(box(category,i%2==0?.002:-.002));
        assertEquals(EventRules.Action.NONE,EventRules.next(t,i,.35,3));
        assertEquals(0,t.seconds(i),0);
      }
    }
  }

  @Test public void eachMovingCategoryCreatesOnceThenOnlyPersonUpgrades() {
    for (int category=0; category<3; category++) {
      ByteTrack.Track t = new ByteTrack.Track(1,box(category,0),0);
      t.confirmed = true;
      int created=0, upgraded=0;
      for (int i=1;i<=20;i++) {
        t.motion.observe(box(category,Math.min(.2,i*.025)));
        EventRules.Action action=EventRules.next(t,i,.35,10);
        if (action==EventRules.Action.CREATE_MOTION) { created++;t.presence=true; }
        if (action==EventRules.Action.UPGRADE_DWELL) { upgraded++;t.dwell=true; }
        assertNotEquals(EventRules.Action.CREATE_DWELL,action);
      }
      assertEquals(1,created);assertEquals(category==0?1:0,upgraded);
    }
  }

  @Test public void stationaryPersonCreatesOnlyDwellAtThreshold() {
    ByteTrack.Track t=new ByteTrack.Track(1,box(0,0),0);
    t.confirmed=true;
    assertEquals(EventRules.Action.NONE,EventRules.next(t,2,.35,3));
    assertEquals(EventRules.Action.CREATE_DWELL,EventRules.next(t,3,.35,3));
    t.presence=t.dwell=true;
    assertEquals(EventRules.Action.NONE,EventRules.next(t,300,.35,3));
  }

  @Test public void oneFrameJumpAndUnconfirmedTargetsDoNotTrigger() {
    ByteTrack.Track t=new ByteTrack.Track(1,box(1,0),0);
    t.motion.observe(box(1,.1));
    t.motion.observe(box(1,0));
    assertFalse(t.motion.detected);
    t.motion.observe(box(1,.1));t.motion.observe(box(1,.15));
    assertEquals(EventRules.Action.NONE,EventRules.next(t,3,.35,3));
  }
}
