package com.airec.host.capture;

import android.graphics.Bitmap;

public final class Signal {
  public static boolean missing(Bitmap image) {
    int w = image.getWidth(), h = image.getHeight(), flat = 0;
    int[][] codes = new int[8][8];
    int green = 0, blue = 0;
    for (int r = 0; r < 8; r++)
      for (int c = 0; c < 8; c++) {
        int[] min = {255, 255, 255}, max = {0, 0, 0};
        int center = 0;
        float[][] points = {{.3f, .3f}, {.7f, .3f}, {.5f, .5f}, {.3f, .7f}, {.7f, .7f}};
        for (int p = 0; p < 5; p++) {
          int v =
              image.getPixel(
                  Math.min(w - 1, (int) ((c + points[p][0]) * w / 8)),
                  Math.min(h - 1, (int) ((r + points[p][1]) * h / 8)));
          if (p == 2) center = v;
          for (int k = 0; k < 3; k++) {
            int value = (v >> (16 - k * 8)) & 255;
            min[k] = Math.min(min[k], value);
            max[k] = Math.max(max[k], value);
          }
        }
        if (max[0] - min[0] <= 20 && max[1] - min[1] <= 20 && max[2] - min[2] <= 20) flat++;
        int red = (center >> 16) & 255, g = (center >> 8) & 255, b = center & 255;
        codes[r][c] = (red > 75 ? 4 : 0) | (g > 75 ? 2 : 0) | (b > 75 ? 1 : 0);
        if (g > 100 && g - Math.max(red, b) > 65) green++;
        if (b > 100 && b - Math.max(red, g) > 65) blue++;
      }
    int[] palette = {7, 6, 3, 2, 5, 4, 1, 0};
    int best = 0;
    for (int phase = 0; phase < 8; phase++) {
      int match = 0;
      for (int r = 0; r < 8; r++)
        for (int c = 0; c < 8; c++) if (codes[r][c] == palette[(c - r + phase + 8) % 8]) match++;
      best = Math.max(best, match);
    }
    return (flat >= 58 && best >= 58) || (flat >= 62 && (green >= 63 || blue >= 63));
  }
}
