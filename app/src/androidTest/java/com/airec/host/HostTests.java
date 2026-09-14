package com.airec.host;

import android.app.Instrumentation;
import android.content.*;
import android.graphics.*;
import android.os.*;
import com.airec.host.capture.Signal;
import com.airec.host.core.*;
import com.airec.host.detection.DetectorService;
import java.io.*;
import java.util.concurrent.*;

/** 真机检查只在测试APK运行，测试图不会进入业务事件或录像索引。 */
public final class HostTests extends Instrumentation {
  private Bundle args;

  public void onCreate(Bundle b) {
    args = b;
    start();
  }

  private void require(boolean ok, String text) {
    if (!ok) throw new AssertionError(text);
  }

  public void onStart() {
    Bundle out = new Bundle();
    try {
      Bitmap image = Bitmap.createBitmap(160, 90, Bitmap.Config.ARGB_8888);
      image.eraseColor(Color.BLACK);
      require(!Signal.missing(image), "黑夜不能判成掉线");
      image.eraseColor(Color.BLUE);
      require(Signal.missing(image), "蓝屏应判掉线");
      image.eraseColor(Color.GREEN);
      require(Signal.missing(image), "绿屏应判掉线");
      int[] palette = {
        Color.WHITE,
        Color.YELLOW,
        Color.CYAN,
        Color.GREEN,
        Color.MAGENTA,
        Color.RED,
        Color.BLUE,
        Color.BLACK
      };
      Canvas canvas = new Canvas(image);
      Paint paint = new Paint();
      for (int r = 0; r < 8; r++)
        for (int c = 0; c < 8; c++) {
          paint.setColor(palette[(c - r + 8) % 8]);
          canvas.drawRect(c * 20, r * 90 / 8f, (c + 1) * 20, (r + 1) * 90 / 8f, paint);
        }
      require(Signal.missing(image), "AHD 占位图不能录像");
      image.recycle();
      out.putString("signal", "PASS");
      Config config = new Config(getTargetContext());
      org.json.JSONObject invalid = config.get();
      J.put(
          invalid.optJSONArray("channels").optJSONObject(0).optJSONObject("recording"),
          "segment_minutes",
          2);
      boolean rejected = false;
      try {
        Config.validate(invalid);
      } catch (IllegalArgumentException e) {
        rejected = true;
      }
      require(rejected, "片段时长校验");
      out.putString("config", "PASS");
      StorageChecks.run(getTargetContext());
      out.putString("timeline_and_loop_recording", "PASS");
      String testImage = args == null ? null : args.getString("image");
      if (testImage != null) {
        byte[] jpeg;
        try (InputStream in = new FileInputStream(testImage)) {
          jpeg = J.read(in, 500000);
        }
        CountDownLatch done = new CountDownLatch(1);
        Bundle[] result = {null};
        Messenger reply =
            new Messenger(
                new Handler(
                    Looper.getMainLooper(),
                    message -> {
                      result[0] = message.getData();
                      done.countDown();
                      return true;
                    }));
        ServiceConnection connection =
            new ServiceConnection() {
              public void onServiceConnected(ComponentName n, IBinder binder) {
                try {
                  Message request = Message.obtain(null, 2);
                  Bundle b = new Bundle();
                  b.putByteArray("jpeg", jpeg);
                  b.putFloat("threshold", .25f);
                  request.setData(b);
                  request.replyTo = reply;
                  new Messenger(binder).send(request);
                } catch (Exception e) {
                  result[0] = JBundle(e.toString());
                  done.countDown();
                }
              }

              public void onServiceDisconnected(ComponentName n) {}
            };
        require(
            getTargetContext()
                .bindService(
                    new Intent(getTargetContext(), DetectorService.class),
                    connection,
                    Context.BIND_AUTO_CREATE),
            "绑定 NPU");
        try {
          require(done.await(30, TimeUnit.SECONDS), "NPU 超时");
          require(!result[0].containsKey("error"), result[0].getString("error"));
          float[] boxes = result[0].getFloatArray("boxes");
          int people = 0, vehicles = 0;
          for (int i = 0; boxes != null && i + 6 < boxes.length; i += 7) {
            if (boxes[i + 4] >= .4f) {
              if (boxes[i + 6] == 0) people++;
              if (boxes[i + 6] == 1) vehicles++;
            }
          }
          require(
              people >= 1 && vehicles >= 1,
              "官方 bus 测试图应同时识别人和车辆；people=" + people + " vehicles=" + vehicles);
          out.putString(
              "npu",
              "PASS people="
                  + people
                  + " vehicles="
                  + vehicles
                  + " SDK="
                  + result[0].getString("version"));
        } finally {
          getTargetContext().unbindService(connection);
        }
      }
      if (args != null && args.getString("codecs", "").equals("yes")) {
        CodecProbe.main(new String[] {"5"});
        out.putString("five_encoders", "PASS four VPU + one software, 90 frames each");
      }
      out.putString("stream", "\nHOST_TESTS_PASS " + out.toString() + "\n");
      finish(-1, out);
    } catch (Throwable e) {
      out.putString("stream", "\nHOST_TESTS_FAIL " + android.util.Log.getStackTraceString(e));
      finish(1, out);
    }
  }

  private Bundle JBundle(String error) {
    Bundle b = new Bundle();
    b.putString("error", error);
    return b;
  }
}
