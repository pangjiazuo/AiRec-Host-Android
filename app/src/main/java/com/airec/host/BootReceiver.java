package com.airec.host;

import android.content.*;

public final class BootReceiver extends BroadcastReceiver {
  public void onReceive(Context c, Intent i) {
    if (Intent.ACTION_BOOT_COMPLETED.equals(i.getAction())
        && c.getSharedPreferences("host", 0).getBoolean("enabled", false)
        && c.checkSelfPermission(android.Manifest.permission.CAMERA)
            == android.content.pm.PackageManager.PERMISSION_GRANTED) {
      c.startForegroundService(new Intent(c, RecorderService.class));
      // Android 9 主机开机后直接展示录像界面，后台服务独立运行。
      try {
        c.startActivity(new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
      } catch (RuntimeException e) {
        android.util.Log.e("AiRecHost", "开机界面启动失败，录像服务继续运行", e);
      }
    }
  }
}
