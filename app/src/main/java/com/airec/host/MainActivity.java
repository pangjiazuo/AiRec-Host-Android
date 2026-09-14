package com.airec.host;

import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.*;
import android.view.*;
import android.webkit.*;
import android.widget.*;
import java.io.*;
import java.net.*;

public final class MainActivity extends Activity {
  private WebView web;
  private final Handler handler = new Handler();
  private String pendingDownload;

  public void onCreate(Bundle b) {
    super.onCreate(b);
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    // 本机屏幕直接使用完整界面，去掉额外的原生按钮栏。
    web = new WebView(this);
    web.setBackgroundColor(0xfff5f6fa);
    web.getSettings().setUseWideViewPort(true);
    web.getSettings().setLoadWithOverviewMode(true);
    if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0)
      WebView.setWebContentsDebuggingEnabled(true);
    web.addJavascriptInterface(new HostBridge(), "HostControl");
    web.getSettings().setJavaScriptEnabled(true);
    web.getSettings().setDomStorageEnabled(true);
    web.getSettings().setMediaPlaybackRequiresUserGesture(false);
    web.getSettings().setAllowFileAccess(false);
    web.getSettings().setAllowContentAccess(false);
    web.setWebViewClient(
        new WebViewClient() {
          public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
            return !localUrl(r.getUrl());
          }
          public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (!localUrl(uri)) return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
            String path = uri.getPath();
            if ("/".equals(path) || (path != null && path.startsWith("/static/"))) {
              String asset = "/".equals(path) ? "index.html" : path.substring(8);
              if (asset.contains("..") || asset.contains("\\")) return null;
              try {
                byte[] bytes;
                try (InputStream in = getAssets().open("web/" + asset); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                  byte[] buffer = new byte[8192]; int count;
                  while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
                  bytes = out.toByteArray();
                }
                if (asset.equals("index.html")) {
                  String html = new String(bytes, java.nio.charset.StandardCharsets.UTF_8)
                      .replace("width=device-width,initial-scale=1", "width=1600");
                  bytes = html.getBytes(java.nio.charset.StandardCharsets.UTF_8);
                }
                String mime = asset.endsWith(".css") ? "text/css" : asset.endsWith(".js") ? "application/javascript" : asset.endsWith(".html") ? "text/html" : "text/plain";
                return new WebResourceResponse(mime, "UTF-8", new ByteArrayInputStream(bytes));
              } catch (IOException error) {
                return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
              }
            }
            return null;
          }
        });
    web.setWebChromeClient(
        new WebChromeClient() {
          public boolean onConsoleMessage(ConsoleMessage m) {
            android.util.Log.i("AiRecWeb", m.message() + " line=" + m.lineNumber());
            return true;
          }
        });
    web.setDownloadListener(
        (url, userAgent, disposition, mime, length) -> {
          if (!localUrl(Uri.parse(url))) return;
          pendingDownload = url;
          Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT);
          save.addCategory(Intent.CATEGORY_OPENABLE);
          // 旧 WebView 的下载回调可能返回空 MIME，文件选择器不能使用空类型。
          save.setType(mime == null || mime.trim().isEmpty() ? "application/octet-stream" : mime);
          save.putExtra(Intent.EXTRA_TITLE, URLUtil.guessFileName(url, disposition, mime));
          try {
            startActivityForResult(save, 2);
          } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "系统未安装文件选择器，可从局域网客户端导出", Toast.LENGTH_LONG).show();
          }
        });
    setContentView(web);
    web.loadUrl("http://127.0.0.1:8080/");
    getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    if (getIntent().getBooleanExtra("stop", false)) stopHost();
    else startHost();
  }

  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    if (intent.getBooleanExtra("stop", false)) stopHost();
    String capture = intent.getStringExtra("captureUi");
    if (capture != null && capture.matches("[a-z0-9-]{1,60}") &&
        (getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
      // 调试构建可直接截取应用视图，用于核对布局，不操作系统弹窗。
      web.postDelayed(() -> {
        android.graphics.Bitmap bitmap = android.graphics.Bitmap.createBitmap(web.getWidth(), web.getHeight(), android.graphics.Bitmap.Config.ARGB_8888);
        try (OutputStream out = new FileOutputStream(new File(getExternalFilesDir("ui-verification"), capture+".png"))) {
          web.draw(new android.graphics.Canvas(bitmap));
          if (!bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,out)) throw new IOException("视图截图失败");
          android.util.Log.i("AiRecWeb", "UI_CAPTURE_OK "+capture);
        } catch (Exception e) { android.util.Log.e("AiRecWeb", "UI_CAPTURE_FAILED", e); }
        finally { bitmap.recycle(); }
      }, 300);
    }
  }

  private boolean localUrl(Uri uri) {
    return "http".equals(uri.getScheme()) && "127.0.0.1".equals(uri.getHost()) && uri.getPort() == 8080;
  }

  private void notifyWeb() {
    if (web != null) web.evaluateJavascript("window.AiRecUI && AiRecUI.nativeState()", null);
  }

  public final class HostBridge {
    @JavascriptInterface public boolean running() { return RecorderService.instance != null; }
    @JavascriptInterface public boolean enabled() { return getSharedPreferences("host", 0).getBoolean("enabled", false); }
    @JavascriptInterface public String address() { return com.airec.host.core.Addresses.local(); }
    @JavascriptInterface public void start() { handler.post(() -> startHost()); }
    @JavascriptInterface public void theme(boolean dark) {
      handler.post(() -> web.setBackgroundColor(dark ? 0xff191b21 : 0xfff5f6fa));
    }
    // 确认弹窗在本机页面统一呈现；这里只负责执行服务操作。
    @JavascriptInterface public void stop() { handler.post(() -> stopHost()); }

  }

  private void stopHost() {
    getSharedPreferences("host", 0).edit().putBoolean("enabled", false).apply();
    stopService(new Intent(this, RecorderService.class));
    handler.postDelayed(this::notifyWeb, 400);
  }

  private void startHost() {
    if (checkSelfPermission(android.Manifest.permission.CAMERA)
        != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(new String[] {android.Manifest.permission.CAMERA}, 1);
      return;
    }
    startForegroundService(new Intent(this, RecorderService.class));
    handler.postDelayed(this::notifyWeb, 1000);
  }

  public void onRequestPermissionsResult(int r, String[] p, int[] g) {
    super.onRequestPermissionsResult(r, p, g);
    if (r == 1 && g.length > 0 && g[0] == PackageManager.PERMISSION_GRANTED) startHost();
    else Toast.makeText(this, "需要摄像头权限才能采集 AHD", Toast.LENGTH_LONG).show();
  }

  public void onBackPressed() {
    web.evaluateJavascript("window.AiRecUI ? AiRecUI.back() : false", value -> {
      if (!"true".equals(value)) moveTaskToBack(true);
    });
  }

  protected void onActivityResult(int request, int result, Intent data) {
    super.onActivityResult(request, result, data);
    if (request != 2
        || result != RESULT_OK
        || data == null
        || data.getData() == null
        || pendingDownload == null) return;
    String url = pendingDownload;
    pendingDownload = null;
    Uri target = data.getData();
    reportExport("running", 0, -1, "");
    new Thread(
            () -> {
              HttpURLConnection connection = null;
              try {
                connection = (HttpURLConnection) new URL(url).openConnection();
                connection.setConnectTimeout(10000);
                connection.setReadTimeout(30000);
                if (connection.getResponseCode() != 200) throw new IOException("下载请求失败");
                try (InputStream in = connection.getInputStream();
                    OutputStream out = getContentResolver().openOutputStream(target)) {
                  if (out == null) throw new IOException("无法写入文件");
                  byte[] buffer = new byte[65536];
                  int n; long received=0, total=connection.getContentLengthLong(), lastUpdate=0;
                  while ((n = in.read(buffer)) != -1) {
                    out.write(buffer, 0, n); received+=n;
                    if (SystemClock.elapsedRealtime()-lastUpdate>200) { reportExport("running", received, total, ""); lastUpdate=SystemClock.elapsedRealtime(); }
                  }
                  if (total>=0 && received!=total) throw new IOException("文件接收不完整，请重新导出");
                }
                reportExport("done", 0, 0, "文件已保存到所选位置");
              } catch (Exception e) {
                try { android.provider.DocumentsContract.deleteDocument(getContentResolver(), target); } catch (Exception ignored) { }
                reportExport("failed", 0, 0, e.getMessage());
              } finally {
                if (connection != null) connection.disconnect();
              }
            },
            "export")
        .start();
  }

  private void reportExport(String phase, long received, long total, String message) {
    String json=com.airec.host.core.J.obj("phase",phase,"received",received,"total",total,"message",message,"label","导出文件").toString();
    handler.post(() -> { if (!isDestroyed()) web.evaluateJavascript("window.AiRecUI && AiRecUI.exportState("+json+")",null); });
  }

  protected void onDestroy() {
    handler.removeCallbacksAndMessages(null);
    web.destroy();
    super.onDestroy();
  }
}
