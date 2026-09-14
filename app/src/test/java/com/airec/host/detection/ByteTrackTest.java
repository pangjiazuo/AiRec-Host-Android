package com.airec.host.detection;

import static org.junit.Assert.*;

import java.util.*;
import org.junit.Test;

public class ByteTrackTest {
  private List<ByteTrack.Box> boxes(double score, int category) {
    return new ArrayList<>(
        Collections.singletonList(
            new ByteTrack.Box(
                .2, .2, .5, .8, score, category == 0 ? 0 : category == 1 ? 2 : 16, category)));
  }

  @Test
  public void confirmationAndDwellUseRealSeconds() {
    ByteTrack t = new ByteTrack();
    List<ByteTrack.Track> a = t.update(boxes(.9, 0), 10, .5, 2);
    assertFalse(a.get(0).confirmed);
    int id = a.get(0).id;
    a = t.update(boxes(.9, 0), 11, .5, 2);
    assertTrue(a.get(0).confirmed);
    assertEquals(id, a.get(0).id);
    assertEquals(1, a.get(0).seconds(11), 1e-8);
    a = t.update(boxes(.9, 0), 12.5, .5, 2);
    assertEquals(2.5, a.get(0).seconds(12.5), 1e-8);
  }

  @Test
  public void weakBoxesCannotCreateOrConfirm() {
    ByteTrack t = new ByteTrack();
    assertTrue(t.update(boxes(.2, 0), 1, .5, 2).isEmpty());
    assertFalse(t.update(boxes(.9, 0), 2, .5, 2).get(0).confirmed);
    assertTrue(t.update(boxes(.2, 0), 3, .5, 2).isEmpty());
  }

  @Test
  public void lowConfidenceMaintainsConfirmedTrack() {
    ByteTrack t = new ByteTrack();
    t.update(boxes(.9, 2), 1, .5, 2);
    int id = t.update(boxes(.9, 2), 2, .5, 2).get(0).id;
    assertEquals(id, t.update(boxes(.2, 2), 3, .5, 2).get(0).id);
  }

  @Test
  public void vehiclesNeverDwellAndExpiredTrackGetsNewId() {
    ByteTrack t = new ByteTrack();
    int id = t.update(boxes(.9, 1), 1, .5, 2).get(0).id;
    ByteTrack.Track v = t.update(boxes(.9, 1), 2, .5, 2).get(0);
    assertEquals(0, v.seconds(99), 0);
    assertNotEquals(id, t.update(boxes(.9, 1), 5, .5, 2).get(0).id);
  }

  @Test
  public void lostTrackNeedsStrongDetection() {
    ByteTrack t = new ByteTrack();
    t.update(boxes(.9, 0), 1, .5, 4);
    int id = t.update(boxes(.9, 0), 2, .5, 4).get(0).id;
    t.update(new ArrayList<>(), 3, .5, 4);
    assertTrue(t.update(boxes(.2, 0), 4, .5, 4).isEmpty());
    assertEquals(id, t.update(boxes(.9, 0), 5, .5, 4).get(0).id);
  }

  @Test
  public void HungarianUsesGlobalMinimum() {
    assertArrayEquals(new int[] {1, 0}, ByteTrack.hungarian(new double[][] {{.1, .2}, {.15, .9}}));
  }

  @Test
  public void fineLabelChangesKeepOneEventAndSeparateObjectsStaySeparate() {
    ByteTrack t = new ByteTrack();
    t.update(boxes(.8, 1), 1, .35, 3);
    ByteTrack.Track first = t.update(boxes(.8, 1), 2, .35, 3).get(0);
    first.eventId = "one-event"; first.presence = true;
    for (int i = 3; i < 300; i++) {
      List<ByteTrack.Box> input = boxes(.55, 1);
      input.get(0).label = i % 2 == 0 ? 2 : 7;
      ByteTrack.Track tracked = t.update(input, i, .35, 3).get(0);
      assertEquals(first.id, tracked.id);
      assertEquals("one-event", tracked.eventId);
    }
    List<ByteTrack.Box> two = boxes(.8, 1);
    two.add(new ByteTrack.Box(.7,.2,.95,.8,.8,2,1));
    assertEquals(2, t.update(two, 300, .35, 3).size());
    assertNotEquals(first.id, t.update(boxes(.8, 1), 310, .35, 3).get(0).id);
  }

  @Test
  public void moderateScoreMovingAnimalCanConfirmWithoutLoweringThreshold() {
    ByteTrack t = new ByteTrack();
    int id = t.update(boxes(.4, 2), 1, .35, 3).get(0).id;
    List<ByteTrack.Box> moved = boxes(.4, 2);
    moved.get(0).x1 += .05; moved.get(0).x2 += .05;
    ByteTrack.Track match = t.update(moved, 2, .35, 3).get(0);
    assertEquals(id, match.id);
    assertTrue(match.confirmed);
    match.eventId = "animal-event";
    t.update(new ArrayList<>(), 3, .35, 3);
    assertEquals("animal-event", t.update(moved, 4, .35, 3).get(0).eventId);
  }
}
