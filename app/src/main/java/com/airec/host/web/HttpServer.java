package com.airec.host.web;

import com.airec.host.*;
import com.airec.host.core.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.zip.*;
import org.json.*;

/** 小型有界 HTTP 服务：范围回放、MJPEG 和 JSON；只提供应用内媒体。 */
public final class HttpServer implements AutoCloseable {
  private final RecorderService app;
  private ServerSocket server;
  private volatile boolean closed;
  private final Set<Socket> clients = ConcurrentHashMap.newKeySet();
  private final ThreadPoolExecutor pool =
      new ThreadPoolExecutor(4, 32, 30, TimeUnit.SECONDS, new SynchronousQueue<>());

  public HttpServer(RecorderService app) {
    this.app = app;
  }

  public void start() throws IOException {
    server = new ServerSocket();
    server.setReuseAddress(true);
    server.bind(new InetSocketAddress(8080));
    new Thread(
            () -> {
              while (!closed)
                try {
                  Socket s = server.accept();
                  s.setSoTimeout(10000);
                  s.setTcpNoDelay(true);
                  clients.add(s);
                  try {
                    pool.execute(() -> serve(s));
                  } catch (RejectedExecutionException e) {
                    clients.remove(s);
                    s.close();
                  }
                } catch (IOException e) {
                  if (!closed) Logs.error("HTTP accept", e);
                }
            },
            "http-accept")
        .start();
  }

  private String line(InputStream in) throws IOException {
    ByteArrayOutputStream b = new ByteArrayOutputStream();
    int c;
    while ((c = in.read()) != -1) {
      if (c == 10) break;
      if (c != 13) b.write(c);
      if (b.size() > 8192) throw new IOException("HTTP line too long");
    }
    return c == -1 && b.size() == 0 ? null : b.toString("ISO-8859-1");
  }

  private void serve(Socket s) {
    try (Socket socket = s) {
      InputStream in = new BufferedInputStream(s.getInputStream());
      OutputStream out = new BufferedOutputStream(s.getOutputStream());
      String first = line(in);
      if (first == null) return;
      String[] parts = first.split(" ");
      if (parts.length != 3) return;
      String method = parts[0];
      Map<String, String> headers = new HashMap<>();
      int total = 0;
      String l;
      while ((l = line(in)) != null && !l.isEmpty()) {
        total += l.length();
        if (total > 16384) throw new IOException("headers too long");
        int colon = l.indexOf(':');
        if (colon < 1) throw new IOException("header");
        String key = l.substring(0, colon).trim().toLowerCase(Locale.ROOT);
        if (headers.put(key, l.substring(colon + 1).trim()) != null)
          throw new IOException("duplicate header");
      }
      try {
        if (headers.containsKey("transfer-encoding")) throw new IllegalArgumentException("不支持分块请求");
        if (!method.equals("GET") && !method.equals("HEAD") && !method.equals("PUT")) {
          json(out, 405, J.obj("error", "不支持的方法"), false);
          return;
        }
        URI uri = new URI(parts[1]);
        String path = uri.getPath();
        Map<String, String> q = query(uri.getRawQuery());
        boolean head = method.equals("HEAD");
        if (method.equals("PUT")) {
          if (!path.equals("/api/config")) {
            json(out, 405, J.obj("error", "不支持的方法"), false);
            return;
          }
          int length = Integer.parseInt(headers.getOrDefault("content-length", "0"));
          if (length <= 0 || length > 65536) throw new IllegalArgumentException("配置最大64KB");
          byte[] body = new byte[length];
          int at = 0;
          while (at < length) {
            int n = in.read(body, at, length - at);
            if (n < 0) throw new IOException("incomplete body");
            at += n;
          }
          JSONObject config = J.parse(new String(body, StandardCharsets.UTF_8));
          String target = config.optJSONObject("storage").optString("target_id");
          app.store.root(target);
          app.config.save(config);
          Logs.info("配置已保存");
          json(
              out,
              200,
              J.obj("ok", true, "config", app.config.get(), "restart_required", false),
              false);
          return;
        }
        if (path.equals("/api/health")) {
          json(out, 200, J.obj("ok", true, "version", "1.0.5-android", "status", "ok"), head);
          return;
        }
        if (path.equals("/api/status")) {
          json(out, 200, app.status(), head);
          return;
        }
        if (path.equals("/api/config")) {
          json(out, 200, app.config.get(), head);
          return;
        }
        if (path.equals("/api/storage/targets")) {
          json(out, 200, app.store.targetInfo(), head);
          return;
        }
        if (path.equals("/api/devices")) {
          json(
              out,
              200,
              J.obj(
                  "devices",
                  new JSONArray()
                      .put(J.obj("path", "/dev/video5", "name", "V4L2 · AHD1"))
                      .put(J.obj("path", "/dev/video0", "name", "V4L2 · AHD2～5 四宫格"))),
              head);
          return;
        }
        if (path.equals("/api/diagnostics/model")) {
          json(out, 200, app.model(), head);
          return;
        }
        if (path.equals("/api/remote-access")) {
          json(
              out,
              200,
              J.obj(
                  "available",
                  false,
                  "installed",
                  false,
                  "state",
                  "disabled",
                  "message",
                  "当前版本仅支持局域网",
                  "urls",
                  new JSONArray()),
              head);
          return;
        }
        if (path.equals("/api/recordings") || path.equals("/api/events")) {
          int ch = channel(q, false);
          String type = q.getOrDefault("event_type", "");
          if (!Arrays.asList("", "person", "vehicle", "animal", "dwell").contains(type))
            throw new IllegalArgumentException("事件类别无效");
          json(
              out,
              200,
              J.obj(
                  "items",
                  app.store.list(path.endsWith("events") ? "event" : "recording", ch, type)),
              head);
          return;
        }
        if (path.equals("/api/timeline")) {
          JSONObject timeline =
              app.store.timeline(
                  channel(q, true), q.getOrDefault("start", ""), q.getOrDefault("end", ""));
          if (timeline.toString().getBytes(StandardCharsets.UTF_8).length > 2 * 1024 * 1024)
            throw new IllegalArgumentException("时间轴过大，请缩小范围");
          json(out, 200, timeline, head);
          return;
        }
        if (path.equals("/api/logs")) {
          JSONArray files = new JSONArray();
          File[] list = new File(app.getFilesDir(), "logs").listFiles();
          if (list != null)
            for (File f : list)
              if (f.isFile())
                files.put(
                    J.obj(
                        "name",
                        f.getName(),
                        "size_bytes",
                        f.length(),
                        "modified_at",
                        J.iso(f.lastModified())));
          json(
              out,
              200,
              J.obj(
                  "items", files, "scope", "应用日志、运行状态与模型诊断；不包含画面和录像。", "max_bundle_bytes", 4194304),
              head);
          return;
        }
        if (path.equals("/api/logs/download")) {
          ByteArrayOutputStream b = new ByteArrayOutputStream();
          try (ZipOutputStream zip = new ZipOutputStream(b)) {
            zip(zip, "status.json", app.status().toString(2).getBytes(StandardCharsets.UTF_8));
            zip(zip, "model.json", app.model().toString(2).getBytes(StandardCharsets.UTF_8));
            for (String name : new String[] {"host.log", "host.previous.log"}) {
              File f = new File(app.getFilesDir(), "logs/" + name);
              if (f.isFile())
                try (InputStream file = new FileInputStream(f)) {
                  zip(zip, name, J.read(file, 1200000));
                }
            }
          }
          send(
              out,
              200,
              "application/zip",
              b.toByteArray(),
              head,
              "Content-Disposition: attachment; filename=airec-logs.zip\r\n");
          return;
        }
        if (path.matches("/api/snapshot/[1-5]\\.jpg")) {
          int id = path.charAt(14) - '1';
          Channel ch = app.channels[id];
          if (!app.config.channel(ch.id).optBoolean("enabled") || !ch.privacyMatches(app.config.channel(ch.id))
              || ch.jpeg == null
              || System.currentTimeMillis() - ch.jpegTime > 4000) {
            json(out, 503, J.obj("error", "通道无有效画面"), head);
            return;
          }
          send(
              out,
              200,
              "image/jpeg",
              ch.jpeg,
              head,
              "1".equals(q.get("download"))
                  ? "Content-Disposition: attachment; filename=AHD" + ch.id + ".jpg\r\n"
                  : "");
          return;
        }
        if (path.matches("/stream/[1-5]\\.mjpg")) {
          Channel ch = app.channels[path.charAt(8) - '1'];
          if (!app.config.channel(ch.id).optBoolean("enabled") || !ch.privacyMatches(app.config.channel(ch.id)) || ch.jpeg == null) {
            json(out, 503, J.obj("error", "通道无有效画面"), head);
            return;
          }
          out.write(
              ("HTTP/1.1 200 OK\r\n"
                      + "Content-Type: multipart/x-mixed-replace; boundary=frame\r\n"
                      + "Cache-Control: no-store\r\n"
                      + "Connection: close\r\n\r\n")
                  .getBytes(StandardCharsets.US_ASCII));
          out.flush();
          if (head) return;
          long sequence = -1;
          ch.viewers.incrementAndGet();
          try {
          while (!closed) {
            byte[] jpeg;
            synchronized (ch) {
              if (sequence == ch.sequence) ch.wait(2000);
              jpeg = ch.jpeg;
              sequence = ch.sequence;
            }
            if (!app.config.channel(ch.id).optBoolean("enabled") || !ch.privacyMatches(app.config.channel(ch.id))
                || jpeg == null
                || System.currentTimeMillis() - ch.jpegTime > 4000) break;
            out.write(
                ("--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                        + jpeg.length
                        + "\r\n\r\n")
                    .getBytes(StandardCharsets.US_ASCII));
            out.write(jpeg);
            out.write(new byte[] {13, 10});
            out.flush();
          }
          } finally { ch.viewers.decrementAndGet(); }
          return;
        }
        if (path.startsWith("/media/")) {
          file(
              out,
              app.store.media(path.substring(7)),
              headers.get("range"),
              head,
              "1".equals(q.get("download")));
          return;
        }
        String asset =
            path.equals("/")
                ? "index.html"
                : path.startsWith("/static/") ? path.substring(8) : path.substring(1);
        if (!asset.matches("[A-Za-z0-9_./-]+") || asset.contains(".."))
          throw new FileNotFoundException();
        try (InputStream f = app.getAssets().open("web/" + asset)) {
          send(out, 200, mime(asset), J.read(f, 4194304), head, "");
        }
      } catch (FileNotFoundException e) {
        json(out, 404, J.obj("error", "文件不存在或介质已移除"), method.equals("HEAD"));
      } catch (SocketException | SocketTimeoutException disconnected) {
        // 切页或关闭预览是正常断连，不向已经关闭的连接追加 JSON。
        return;
      } catch (IllegalArgumentException | java.time.DateTimeException e) {
        json(out, 400, J.obj("error", e.getMessage()), method.equals("HEAD"));
      } catch (Exception e) {
        Logs.error("HTTP " + parts[1].split("\\?")[0], e);
        json(out, 503, J.obj("error", "服务暂不可用：" + e.getMessage()), method.equals("HEAD"));
      }
    } catch (Exception ignored) {
    } finally {
      clients.remove(s);
    }
  }

  private int channel(Map<String, String> q, boolean required) {
    if (!q.containsKey("channel_id")) {
      if (required) throw new IllegalArgumentException("缺少通道");
      return 0;
    }
    int n = Integer.parseInt(q.get("channel_id"));
    if (n < 1 || n > 5) throw new IllegalArgumentException("通道无效");
    return n;
  }

  private Map<String, String> query(String raw) throws Exception {
    Map<String, String> q = new HashMap<>();
    if (raw != null)
      for (String pair : raw.split("&")) {
        String[] kv = pair.split("=", 2);
        String k = URLDecoder.decode(kv[0], "UTF-8"),
            v = kv.length == 2 ? URLDecoder.decode(kv[1], "UTF-8") : "";
        if (q.put(k, v) != null) throw new IllegalArgumentException("参数不能重复");
      }
    return q;
  }

  private String mime(String name) {
    return name.endsWith(".html")
        ? "text/html; charset=utf-8"
        : name.endsWith(".js")
            ? "application/javascript; charset=utf-8"
            : name.endsWith(".css")
                ? "text/css; charset=utf-8"
                : name.endsWith(".svg")
                    ? "image/svg+xml"
                    : name.endsWith(".mp4")
                        ? "video/mp4"
                        : name.endsWith(".jpg") ? "image/jpeg" : "application/octet-stream";
  }

  private void json(OutputStream out, int code, JSONObject object, boolean head)
      throws IOException {
    send(
        out,
        code,
        "application/json; charset=utf-8",
        object.toString().getBytes(StandardCharsets.UTF_8),
        head,
        "");
  }

  private void send(
      OutputStream out, int code, String type, byte[] body, boolean head, String extra)
      throws IOException {
    header(out, code, type, body.length, extra);
    if (!head) out.write(body);
    out.flush();
  }

  private void header(OutputStream out, int code, String type, long length, String extra)
      throws IOException {
    out.write(
        ("HTTP/1.1 "
                + code
                + " "
                + (code == 200 ? "OK" : code == 206 ? "Partial Content" : "Error")
                + "\r\nContent-Type: "
                + type
                + "\r\nContent-Length: "
                + length
                + "\r\n"
                + "Cache-Control: no-store\r\n"
                + "Connection: close\r\n"
                + "X-Content-Type-Options: nosniff\r\n"
                + extra
                + "\r\n")
            .getBytes(StandardCharsets.US_ASCII));
  }

  private void file(OutputStream out, File f, String range, boolean head, boolean download)
      throws IOException {
    try (RandomAccessFile input = new RandomAccessFile(f, "r")) {
      long size = input.length(), start = 0, end = size - 1;
      int code = 200;
      if (range != null) {
        try {
          if (!range.matches("bytes=[0-9]*-[0-9]*")) throw new IllegalArgumentException();
          String[] r = range.substring(6).split("-", -1);
          if (r[0].isEmpty()) {
            long suffix = Long.parseLong(r[1]);
            if (suffix <= 0) throw new IllegalArgumentException();
            start = Math.max(0, size - suffix);
          } else {
            start = Long.parseLong(r[0]);
            if (!r[1].isEmpty()) end = Math.min(end, Long.parseLong(r[1]));
          }
          if (start > end || start >= size) throw new IllegalArgumentException();
          code = 206;
        } catch (Exception e) {
          send(
              out, 416, "text/plain", new byte[0], head, "Content-Range: bytes */" + size + "\r\n");
          return;
        }
      }
      header(
          out,
          code,
          mime(f.getName()),
          end - start + 1,
          (download ? "Content-Disposition: attachment; filename=" + f.getName() + "\r\n" : "")
              + "Accept-Ranges: bytes\r\n"
              + (code == 206
                  ? "Content-Range: bytes " + start + "-" + end + "/" + size + "\r\n"
                  : ""));
      if (!head) {
        input.seek(start);
        byte[] b = new byte[65536];
        long remaining = end - start + 1;
        while (remaining > 0) {
          int n = input.read(b, 0, (int) Math.min(b.length, remaining));
          if (n < 0) break;
          out.write(b, 0, n);
          remaining -= n;
        }
      }
      out.flush();
    }
  }

  private void zip(ZipOutputStream zip, String name, byte[] b) throws IOException {
    zip.putNextEntry(new ZipEntry(name));
    zip.write(b);
    zip.closeEntry();
  }

  public void close() {
    closed = true;
    try {
      server.close();
    } catch (Exception ignored) {
    }
    for (Socket s : clients)
      try {
        s.close();
      } catch (Exception ignored) {
      }
    pool.shutdownNow();
  }
}
