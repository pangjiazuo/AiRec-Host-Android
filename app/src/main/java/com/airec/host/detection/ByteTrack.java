package com.airec.host.detection;

import java.util.*;

/** ByteTrack：高低置信度两阶段关联、XYAH Kalman 和全局匈牙利匹配。 算法来源及许可证见 licenses；时间用真实秒数，适合低频 NPU 采样。 */
public final class ByteTrack {
  public static final class Box {
    public double x1, y1, x2, y2, score;
    public int label, category;

    public Box(double x1, double y1, double x2, double y2, double score, int label, int category) {
      this.x1 = x1;
      this.y1 = y1;
      this.x2 = x2;
      this.y2 = y2;
      this.score = score;
      this.label = label;
      this.category = category;
    }
  }

  public static final class Track {
    public int id;
    public Box box;
    public double first, last, predicted, interval;
    public boolean confirmed, presence, dwell;
    int state;
    double[] mean;
    double[][] covariance;

    Track(int id, Box b, double now) {
      this.id = id;
      box = b;
      first = last = predicted = now;
      mean = new double[8];
      System.arraycopy(measure(b), 0, mean, 0, 4);
      double h = mean[3];
      covariance = diag(new double[] {h / 10, h / 10, .01, h / 10, h / 16, h / 16, .00001, h / 16});
    }

    public double seconds(double now) {
      return box.category == 1 ? 0 : Math.max(0, now - first);
    }
  }

  private final List<Track> tracks = new ArrayList<>();
  private int nextId = 1;
  private double previous = -1;

  public List<Track> update(List<Box> input, double now, double high, double tolerance) {
    if (now <= previous) return Collections.emptyList();
    previous = now;
    tracks.removeIf(t -> now - t.last > tolerance);
    if (tracks.size() > 256) {
      tracks.sort(
          Comparator.comparingInt((Track t) -> t.state == 1 ? 0 : 1)
              .thenComparingDouble(t -> -t.last));
      tracks.subList(256, tracks.size()).clear();
    }
    List<Box> strong = new ArrayList<>(), weak = new ArrayList<>();
    input.sort((a, b) -> Double.compare(b.score, a.score));
    int count = 0;
    for (Box b : input) {
      if (++count > 256) break;
      if (b.score >= high) strong.add(b);
      else if (b.score >= Math.min(.1, high / 2)) weak.add(b);
    }
    List<Track> pool = new ArrayList<>(), tentative = new ArrayList<>();
    for (Track t : tracks) {
      predict(t, now);
      if (t.confirmed) pool.add(t);
      else tentative.add(t);
    }
    List<Track> visible = new ArrayList<>();
    double firstLimit = high < .25 ? 1 - high * .2 : .8;
    List<Track> unmatched = associate(pool, strong, firstLimit, true, now, true, visible);
    List<Track> active = new ArrayList<>();
    for (Track t : unmatched) if (t.state == 1) active.add(t);
    List<Track> lost = associate(active, weak, .5, false, now, false, visible);
    for (Track t : lost) t.state = 2;
    double tentativeLimit = high < .35 ? 1 - high * .3 : .7;
    List<Track> rejected = associate(tentative, strong, tentativeLimit, true, now, true, visible);
    tracks.removeAll(rejected);
    for (Box b : strong) {
      Track t = new Track(nextId++, b, now);
      tracks.add(t);
      visible.add(t);
    }
    Set<Track> duplicates = new HashSet<>();
    for (Track a : tracks)
      if (a.state == 1)
        for (Track b : tracks)
          if (b.state == 2 && same(a.box, b.box) && iou(predictedBox(a), predictedBox(b)) > .85)
            duplicates.add(a.last - a.first >= b.last - b.first ? b : a);
    tracks.removeAll(duplicates);
    visible.removeAll(duplicates);
    return visible;
  }

  public void expire(double now, double tolerance) {
    tracks.removeIf(t -> now - t.last > tolerance);
  }

  public void reset() {
    tracks.clear();
    previous = -1;
  }

  private List<Track> associate(
      List<Track> ts,
      List<Box> boxes,
      double limit,
      boolean fuse,
      double now,
      boolean confirm,
      List<Track> visible) {
    int rows = ts.size(), cols = boxes.size();
    List<Track> un = new ArrayList<>();
    if (rows == 0) return un;
    if (cols == 0) {
      un.addAll(ts);
      return un;
    }
    int size = rows + cols;
    double[][] cost = new double[size][size];
    for (double[] r : cost) Arrays.fill(r, 1e6);
    for (int i = 0; i < rows; i++) {
      for (int j = 0; j < cols; j++) {
        double c =
            same(ts.get(i).box, boxes.get(j))
                ? 1 - iou(predictedBox(ts.get(i)), boxes.get(j)) * (fuse ? boxes.get(j).score : 1)
                : 1;
        if (c <= limit) cost[i][j] = c;
      }
      cost[i][cols + i] = (limit + 1e-9) / 2;
    }
    for (int j = 0; j < cols; j++) {
      cost[rows + j][j] = (limit + 1e-9) / 2;
      for (int i = cols; i < size; i++) cost[rows + j][i] = 0;
    }
    int[] match = hungarian(cost);
    Set<Box> used = new HashSet<>();
    for (int i = 0; i < rows; i++) {
      int j = match[i];
      if (j < cols && cost[i][j] <= limit) {
        Track t = ts.get(i);
        Box b = boxes.get(j);
        correct(t, b);
        t.box = b;
        t.last = now;
        t.state = 1;
        if (confirm) t.confirmed = true;
        visible.add(t);
        used.add(b);
      } else un.add(ts.get(i));
    }
    boxes.removeAll(used);
    return un;
  }

  private static boolean same(Box a, Box b) {
    return a.label == b.label && a.category == b.category;
  }

  public static double iou(Box a, Box b) {
    double inter =
        Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1))
            * Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
    double area = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
    return area > 0 ? inter / area : 0;
  }

  private static double[] measure(Box b) {
    double h = Math.max(.00001, b.y2 - b.y1);
    return new double[] {(b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2, (b.x2 - b.x1) / h, h};
  }

  private static Box predictedBox(Track t) {
    double h = Math.max(.00001, t.mean[3]), w = Math.max(.00001, t.mean[2] * h);
    return new Box(
        t.mean[0] - w / 2,
        t.mean[1] - h / 2,
        t.mean[0] + w / 2,
        t.mean[1] + h / 2,
        t.box.score,
        t.box.label,
        t.box.category);
  }

  private static double[][] diag(double[] deviations) {
    double[][] out = new double[deviations.length][deviations.length];
    for (int i = 0; i < deviations.length; i++) out[i][i] = deviations[i] * deviations[i];
    return out;
  }

  private static double[][] identity(int n) {
    double[][] a = new double[n][n];
    for (int i = 0; i < n; i++) a[i][i] = 1;
    return a;
  }

  private static double[][] transpose(double[][] a) {
    double[][] r = new double[a[0].length][a.length];
    for (int i = 0; i < a.length; i++) for (int j = 0; j < a[0].length; j++) r[j][i] = a[i][j];
    return r;
  }

  private static double[][] multiply(double[][] a, double[][] b) {
    double[][] r = new double[a.length][b[0].length];
    for (int i = 0; i < a.length; i++)
      for (int k = 0; k < b.length; k++)
        for (int j = 0; j < b[0].length; j++) r[i][j] += a[i][k] * b[k][j];
    return r;
  }

  private static double[][] add(double[][] a, double[][] b) {
    double[][] r = new double[a.length][a[0].length];
    for (int i = 0; i < a.length; i++)
      for (int j = 0; j < a[0].length; j++) r[i][j] = a[i][j] + b[i][j];
    return r;
  }

  private static double[][] inverse(double[][] input) {
    int n = input.length;
    double[][] a = new double[n][2 * n];
    for (int i = 0; i < n; i++) {
      System.arraycopy(input[i], 0, a[i], 0, n);
      a[i][n + i] = 1;
    }
    for (int col = 0; col < n; col++) {
      int pivot = col;
      for (int r = col + 1; r < n; r++)
        if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
      double[] swap = a[col];
      a[col] = a[pivot];
      a[pivot] = swap;
      double v = a[col][col];
      if (Math.abs(v) < 1e-15) v = 1e-15;
      for (int j = 0; j < 2 * n; j++) a[col][j] /= v;
      for (int r = 0; r < n; r++)
        if (r != col) {
          v = a[r][col];
          for (int j = 0; j < 2 * n; j++) a[r][j] -= v * a[col][j];
        }
    }
    double[][] out = new double[n][n];
    for (int i = 0; i < n; i++) System.arraycopy(a[i], n, out[i], 0, n);
    return out;
  }

  private static void predict(Track t, double now) {
    double dt = Math.max(.001, now - t.predicted);
    if (t.interval == 0) {
      t.interval = Math.max(.001, now - t.first);
      for (int i = 4; i < 8; i++)
        for (int j = 4; j < 8; j++) t.covariance[i][j] /= t.interval * t.interval;
    }
    if (t.state == 2) t.mean[7] = 0;
    double[][] f = identity(8);
    for (int i = 0; i < 4; i++) {
      f[i][i + 4] = dt;
      t.mean[i] += dt * t.mean[i + 4];
    }
    double h = Math.max(.00001, t.mean[3]), scale = Math.sqrt(Math.max(.001, dt / t.interval));
    double[] noise = {h / 20, h / 20, .01, h / 20, h / 160, h / 160, .00001, h / 160};
    for (int i = 0; i < 8; i++) noise[i] *= scale / (i >= 4 ? t.interval : 1);
    t.covariance = add(multiply(multiply(f, t.covariance), transpose(f)), diag(noise));
    t.predicted = now;
  }

  private static void correct(Track t, Box box) {
    double h = Math.max(.00001, t.mean[3]);
    double[][] r = diag(new double[] {h / 20, h / 20, .1, h / 20}),
        s = new double[4][4],
        cross = new double[8][4];
    for (int i = 0; i < 8; i++)
      for (int j = 0; j < 4; j++) {
        cross[i][j] = t.covariance[i][j];
        if (i < 4) s[i][j] = t.covariance[i][j] + r[i][j];
      }
    double[][] k = multiply(cross, inverse(s));
    double[] z = measure(box), innovation = new double[4];
    for (int j = 0; j < 4; j++) innovation[j] = z[j] - t.mean[j];
    for (int i = 0; i < 8; i++) for (int j = 0; j < 4; j++) t.mean[i] += k[i][j] * innovation[j];
    double[][] ikh = identity(8);
    for (int i = 0; i < 8; i++) for (int j = 0; j < 4; j++) ikh[i][j] -= k[i][j];
    t.covariance =
        add(
            multiply(multiply(ikh, t.covariance), transpose(ikh)),
            multiply(multiply(k, r), transpose(k)));
  }

  // O(n^3)，输入最多256个候选，拒绝边由虚拟行列表示。
  static int[] hungarian(double[][] a) {
    int n = a.length;
    double[] u = new double[n + 1], v = new double[n + 1];
    int[] p = new int[n + 1], way = new int[n + 1];
    for (int i = 1; i <= n; i++) {
      p[0] = i;
      int j0 = 0;
      double[] min = new double[n + 1];
      Arrays.fill(min, Double.POSITIVE_INFINITY);
      boolean[] used = new boolean[n + 1];
      do {
        used[j0] = true;
        int i0 = p[j0], j1 = 0;
        double delta = Double.POSITIVE_INFINITY;
        for (int j = 1; j <= n; j++)
          if (!used[j]) {
            double cur = a[i0 - 1][j - 1] - u[i0] - v[j];
            if (cur < min[j]) {
              min[j] = cur;
              way[j] = j0;
            }
            if (min[j] < delta) {
              delta = min[j];
              j1 = j;
            }
          }
        for (int j = 0; j <= n; j++)
          if (used[j]) {
            u[p[j]] += delta;
            v[j] -= delta;
          } else min[j] -= delta;
        j0 = j1;
      } while (p[j0] != 0);
      do {
        int j1 = way[j0];
        p[j0] = p[j1];
        j0 = j1;
      } while (j0 != 0);
    }
    int[] out = new int[n];
    for (int j = 1; j <= n; j++) out[p[j] - 1] = j - 1;
    return out;
  }
}
