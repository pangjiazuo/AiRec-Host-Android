package com.airec.host.capture;

import android.content.Context;
import android.graphics.*;
import android.view.*;
import android.widget.FrameLayout;
import com.airec.host.RecorderService;
import com.airec.host.core.Channel;
import org.json.*;

/** 页面只上报视频区域位置；像素由采集线程直接送入 SurfaceView。 */
public final class LocalPreview extends FrameLayout {
  private final Tile[] tiles = new Tile[5];
  public LocalPreview(Context context) { super(context); setClipChildren(true); }

  public void layoutVideos(String json) {
    try {
      JSONObject message = new JSONObject(json);
      JSONArray items = message.getJSONArray("items");
      float scale = getWidth() / (float)message.getDouble("width");
      boolean[] visible = new boolean[5];
      for (int n = 0; n < items.length(); n++) {
        JSONObject item = items.getJSONObject(n);
        int i = item.getInt("id") - 1;
        if (i < 0 || i >= 5 || !Float.isFinite(scale)) continue;
        int w = Math.round((float)item.getDouble("w") * scale);
        int h = Math.round((float)item.getDouble("h") * scale);
        if (w < 2 || h < 2) continue;
        visible[i] = true;
        if (tiles[i] == null) { tiles[i] = new Tile(getContext(), i); addView(tiles[i]); }
        Tile tile = tiles[i];
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(w, h);
        params.leftMargin = Math.round((float)item.getDouble("x") * scale);
        params.topMargin = Math.round((float)item.getDouble("y") * scale);
        FrameLayout.LayoutParams old = (FrameLayout.LayoutParams)tile.getLayoutParams();
        if (old.width != w || old.height != h || old.leftMargin != params.leftMargin || old.topMargin != params.topMargin)
          tile.setLayoutParams(params);
        tile.setVisibility(VISIBLE);
        tile.labels = item.optBoolean("labels");
        tile.buttons = item.optJSONArray("buttons");
        float radius = (float)item.optDouble("radius", 12);
        if (tile.radius != radius) { tile.radius = radius; tile.invalidateOutline(); }
        RecorderService host = RecorderService.instance;
        String state = host == null ? "" : host.channels[i].detections.toString() + host.channels[i].recording
            + host.config.channel(i + 1).optString("name") + tile.labels + tile.buttons;
        if (!state.equals(tile.lastState)) { tile.lastState = state; tile.overlay.invalidate(); }
        tile.attach();
      }
      for (int i = 0; i < 5; i++) if (!visible[i] && tiles[i] != null) tiles[i].hide();
    } catch (JSONException ignored) { hideAll(); }
  }

  public void hideAll() { for (Tile tile : tiles) if (tile != null) tile.hide(); }

  private final class Tile extends FrameLayout implements SurfaceHolder.Callback {
    final int index;
    final SurfaceView video;
    final View overlay;
    Surface surface;
    Capture attached;
    boolean labels;
    JSONArray buttons;
    float radius = 12;
    String lastState = "";
    int attachedWidth, attachedHeight;
    Tile(Context context, int index) {
      super(context); this.index = index;
      video = new SurfaceView(context); video.getHolder().setFormat(PixelFormat.RGBA_8888); video.getHolder().addCallback(this);
      addView(video, new FrameLayout.LayoutParams(-1, -1));
      overlay = new View(context) {
        final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        protected void onDraw(Canvas canvas) {
          RecorderService host = RecorderService.instance;
          if (host == null) return;
          Channel ch = host.channels[index];
          float unit = LocalPreview.this.getWidth() / 1600f;
          p.setTextSize(13 * unit);
          if (labels) {
            String name = host.config.channel(index + 1).optString("name", "AHD" + (index + 1));
            badge(canvas, name, 14 * unit, 12 * unit, unit);
            if (ch.recording) badge(canvas, "● 录像中", getWidth() - 100 * unit, 12 * unit, unit);
          }
          // 原有类别与停留提示继续显示，按源画面比例定位。
          for (int j = 0; j < ch.detections.length(); j++) {
            JSONObject d = ch.detections.optJSONObject(j);
            if (d == null) continue;
            JSONArray b = d.optJSONArray("bbox");
            if (b == null || b.length() != 4) continue;
            String category = d.optString("category");
            boolean dwell = !category.equals("vehicle") && d.optBoolean("dwell_reached");
            p.setColor(dwell ? 0xffdd6b75 : category.equals("animal") ? 0xff39a185 : category.equals("vehicle") ? 0xffa071d0 : 0xff4084e9);
            p.setStrokeWidth(2 * unit); p.setStyle(Paint.Style.STROKE);
            float x = (float)b.optDouble(0) * getWidth(), y = (float)b.optDouble(1) * getHeight();
            canvas.drawRect(x, y, (float)b.optDouble(2) * getWidth(), (float)b.optDouble(3) * getHeight(), p);
            p.setStyle(Paint.Style.FILL);
            String title = category.equals("animal") ? "动物" : category.equals("vehicle") ? "车" : "人";
            if (!category.equals("vehicle")) title += " · " + (dwell ? "长时间停留 " : "") + String.format(java.util.Locale.ROOT, "%.1f 秒", d.optDouble("dwell_seconds"));
            p.setTextSize(12 * unit);
            float labelTop = Math.max(0, y - 22 * unit);
            p.setColor(0xcc17202a);
            canvas.drawRect(x, labelTop, Math.min(getWidth(), x + p.measureText(title) + 8 * unit), labelTop + 22 * unit, p);
            p.setColor(Color.WHITE);
            canvas.drawText(title, x + 4 * unit, labelTop + 16 * unit, p);
          }
          // 原网页控件仍负责点击；在直显表面上保留对应的按钮外观。
          if (buttons != null) for (int j = 0; j < buttons.length(); j++) {
            JSONObject b = buttons.optJSONObject(j); if (b == null) continue;
            float x = (float)b.optDouble("x") * getWidth(), y = (float)b.optDouble("y") * getHeight();
            float w = (float)b.optDouble("w") * getWidth(), h = (float)b.optDouble("h") * getHeight();
            p.setColor(0xcc15191e); p.setStyle(Paint.Style.FILL);
            canvas.drawRoundRect(x, y, x + w, y + h, 9 * unit, 9 * unit, p);
            p.setColor(Color.WHITE); p.setTextSize(12 * unit);
            String text = b.optString("text");
            canvas.drawText(text, x + (w - p.measureText(text)) / 2, y + (h - p.ascent() - p.descent()) / 2, p);
          }
        }
        void badge(Canvas c, String text, float x, float y, float unit) {
          p.setStyle(Paint.Style.FILL); p.setColor(0x9910151b);
          c.drawRoundRect(x, y, x + p.measureText(text) + 18 * unit, y + 30 * unit, 6 * unit, 6 * unit, p);
          p.setColor(Color.WHITE); c.drawText(text, x + 9 * unit, y + 20 * unit, p);
        }
      };
      addView(overlay, new FrameLayout.LayoutParams(-1, -1));
      setClipToOutline(true);
      setOutlineProvider(new ViewOutlineProvider() {
        public void getOutline(View v, Outline o) { o.setRoundRect(0, 0, v.getWidth(), v.getHeight(), radius * LocalPreview.this.getWidth() / 1600f); }
      });
    }
    void attach() {
      RecorderService service = RecorderService.instance;
      Capture capture = service == null ? null : service.capture;
      if (surface != null && getVisibility() == VISIBLE && capture != null) {
        if (attached == capture && attachedWidth == video.getWidth() && attachedHeight == video.getHeight()) return;
        attachedWidth = video.getWidth(); attachedHeight = video.getHeight();
        capture.localPreview(index, surface, Math.max(2, video.getWidth()), Math.max(2, video.getHeight()));
        attached = capture;
      }
    }
    void hide() {
      setVisibility(INVISIBLE);
      if (attached != null) attached.localPreview(index, null, 0, 0);
      attached = null;
    }
    public void surfaceCreated(SurfaceHolder holder) { surface = holder.getSurface(); attach(); }
    public void surfaceChanged(SurfaceHolder holder, int format, int w, int h) { surface = holder.getSurface(); attach(); }
    public void surfaceDestroyed(SurfaceHolder holder) {
      RecorderService host = RecorderService.instance;
      Capture target = attached != null ? attached : host == null ? null : host.capture;
      if (target != null) target.releaseLocalPreview(index);
      attached = null; surface = null;
    }
  }
}
