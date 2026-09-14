#include <GLES2/gl2.h>
#include <jni.h>
#include <linux/videodev2.h>
#include <poll.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <cerrno>
#include <cstring>
#include <string>
#include <vector>
#include <unordered_map>
struct Mapping {
  void* ptr;
  size_t size;
};
struct Video {
  int fd = -1, width = 0, height = 0;
  std::unordered_map<int, int> textureWidths;
  std::vector<unsigned char> thumbnail;
  bool streaming = false;
  std::vector<Mapping> buffers;
  ~Video() {
    if (fd >= 0) {
      if (streaming) {
        int type = V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE;
        ioctl(fd, VIDIOC_STREAMOFF, &type);
      }
      for (auto b : buffers) munmap(b.ptr, b.size);
      close(fd);
    }
  }
};
static void fail(JNIEnv* e, const std::string& message) {
  e->ThrowNew(e->FindClass("java/io/IOException"), message.c_str());
}
extern "C" JNIEXPORT jint JNICALL
Java_com_airec_host_capture_NativeVideo_listen(JNIEnv* e, jclass,
                                               jstring name) {
  const char* n = e->GetStringUTFChars(name, nullptr);
  int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  sockaddr_un addr{};
  addr.sun_family = AF_UNIX;
  strncpy(addr.sun_path + 1, n, sizeof(addr.sun_path) - 2);
  int length = offsetof(sockaddr_un, sun_path) + 1 + strlen(n);
  e->ReleaseStringUTFChars(name, n);
  if (bind(fd, (sockaddr*)&addr, length) || listen(fd, 1)) {
    close(fd);
    fail(e, "视频描述符 socket 失败");
    return -1;
  }
  return fd;
}
extern "C" JNIEXPORT jlong JNICALL
Java_com_airec_host_capture_NativeVideo_accept(JNIEnv* e, jclass, jint server,
                                               jint width, jint height) {
  pollfd ready{server, POLLIN, 0};
  if (poll(&ready, 1, 5000) != 1) {
    close(server);
    fail(e, "未取得 AHD 权限，请确认固件允许 su 0");
    return 0;
  }
  int sock = accept4(server, nullptr, nullptr, SOCK_CLOEXEC);
  close(server);
  ucred peer{};
  socklen_t size = sizeof(peer);
  if (getsockopt(sock, SOL_SOCKET, SO_PEERCRED, &peer, &size) ||
      peer.uid != 0) {
    close(sock);
    fail(e, "视频描述符来源必须为 root helper");
    return 0;
  }
  timeval timeout{3, 0};
  setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
  char control[CMSG_SPACE(sizeof(int))]{}, byte;
  iovec io{&byte, 1};
  msghdr msg{};
  msg.msg_iov = &io;
  msg.msg_iovlen = 1;
  msg.msg_control = control;
  msg.msg_controllen = sizeof(control);
  int n = recvmsg(sock, &msg, MSG_CMSG_CLOEXEC);
  close(sock);
  cmsghdr* c = CMSG_FIRSTHDR(&msg);
  if (n != 1 || !c || c->cmsg_level != SOL_SOCKET ||
      c->cmsg_type != SCM_RIGHTS) {
    fail(e, "未收到 AHD 描述符");
    return 0;
  }
  Video* v = new Video();
  memcpy(&v->fd, CMSG_DATA(c), sizeof(int));
  v4l2_format fmt{};
  fmt.type = V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE;
  fmt.fmt.pix_mp.width = width;
  fmt.fmt.pix_mp.height = height;
  fmt.fmt.pix_mp.pixelformat = V4L2_PIX_FMT_YUYV;
  fmt.fmt.pix_mp.field = V4L2_FIELD_NONE;
  if (ioctl(v->fd, VIDIOC_S_FMT, &fmt) || fmt.fmt.pix_mp.width != width ||
      fmt.fmt.pix_mp.height != height ||
      fmt.fmt.pix_mp.pixelformat != V4L2_PIX_FMT_YUYV ||
      fmt.fmt.pix_mp.num_planes != 1 ||
      fmt.fmt.pix_mp.plane_fmt[0].bytesperline != width * 2) {
    delete v;
    fail(e, "AHD 输出格式不符，要求紧密 YUYV");
    return 0;
  }
  v->width = width;
  v->height = height;
  v4l2_requestbuffers req{};
  req.type = V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE;
  req.memory = V4L2_MEMORY_MMAP;
  req.count = 4;
  if (ioctl(v->fd, VIDIOC_REQBUFS, &req) || req.count < 2) {
    delete v;
    fail(e, "申请 AHD 缓冲失败");
    return 0;
  }
  for (unsigned i = 0; i < req.count; i++) {
    v4l2_plane plane{};
    v4l2_buffer b{};
    b.m.planes = &plane;
    b.length = 1;
    b.type = req.type;
    b.memory = req.memory;
    b.index = i;
    if (ioctl(v->fd, VIDIOC_QUERYBUF, &b)) {
      delete v;
      fail(e, "查询 AHD 缓冲失败");
      return 0;
    }
    if (plane.length < size_t(width) * height * 2) {
      delete v;
      fail(e, "AHD 缓冲长度不足");
      return 0;
    }
    void* ptr = mmap(nullptr, plane.length, PROT_READ | PROT_WRITE, MAP_SHARED,
                     v->fd, plane.m.mem_offset);
    if (ptr == MAP_FAILED) {
      delete v;
      fail(e, "映射 AHD 缓冲失败");
      return 0;
    }
    v->buffers.push_back({ptr, plane.length});
    if (ioctl(v->fd, VIDIOC_QBUF, &b)) {
      delete v;
      fail(e, "排队 AHD 缓冲失败");
      return 0;
    }
  }
  int type = V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE;
  if (ioctl(v->fd, VIDIOC_STREAMON, &type)) {
    delete v;
    fail(e, "启动 AHD 采集失败");
    return 0;
  }
  v->streaming = true;
  return reinterpret_cast<jlong>(v);
}
extern "C" JNIEXPORT jboolean JNICALL
Java_com_airec_host_capture_NativeVideo_update(JNIEnv* e, jclass, jlong handle,
                                               jint texture, jboolean tiny) {
  Video* v = reinterpret_cast<Video*>(handle);
  v4l2_plane selectedPlane{};
  v4l2_buffer selected{};
  selected.m.planes = &selectedPlane;
  bool got = false;
  // 消费积压缓冲但只上传最新帧，空通道降频后也不会播放陈旧画面。
  for (size_t attempt = 0; attempt < v->buffers.size(); attempt++) {
    v4l2_plane plane{};
    v4l2_buffer b{};
    b.m.planes = &plane;
    b.length = 1;
    b.type = V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE;
    b.memory = V4L2_MEMORY_MMAP;
    if (ioctl(v->fd, VIDIOC_DQBUF, &b)) {
      if (errno == EAGAIN) break;
      fail(e, "AHD 取帧失败");
      return false;
    }
    if (b.index >= v->buffers.size()) {
      fail(e, "AHD 缓冲编号异常");
      return false;
    }
    if (got && ioctl(v->fd, VIDIOC_QBUF, &selected)) {
      fail(e, "AHD 归还缓冲失败");
      return false;
    }
    selected = b;
    selectedPlane = plane;
    selected.m.planes = &selectedPlane;
    got = true;
  }
  if (!got) return false;
  glBindTexture(GL_TEXTURE_2D, texture);
  glPixelStorei(GL_UNPACK_ALIGNMENT, 4);
  int width = tiny ? 256 : v->width, height = tiny ? 144 : v->height;
  const void* data = v->buffers[selected.index].ptr;
  if (tiny) {
    v->thumbnail.resize(width * height * 2);
    auto* src = static_cast<unsigned char*>(v->buffers[selected.index].ptr);
    for (int y = 0; y < height; y++)
      for (int x = 0; x < width; x += 2) {
        int sy = y * v->height / height, sx = x * v->width / width,
            sx2 = (x + 1) * v->width / width;
        auto* d = v->thumbnail.data() + (y * width + x) * 2;
        auto* p = src + (sy * v->width + (sx & ~1)) * 2;
        auto* p2 = src + (sy * v->width + (sx2 & ~1)) * 2;
        d[0] = p[sx % 2 ? 2 : 0];
        d[1] = p[1];
        d[2] = p2[sx2 % 2 ? 2 : 0];
        d[3] = p[3];
      }
    data = v->thumbnail.data();
  }
  if (v->textureWidths[texture] != width) {
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, width / 2, height, 0, GL_RGBA,
                 GL_UNSIGNED_BYTE, data);
    v->textureWidths[texture] = width;
  } else
    glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, width / 2, height, GL_RGBA,
                    GL_UNSIGNED_BYTE, data);
  if (ioctl(v->fd, VIDIOC_QBUF, &selected)) {
    fail(e, "AHD 归还缓冲失败");
    return false;
  }
  return true;
}
extern "C" JNIEXPORT void JNICALL
Java_com_airec_host_capture_NativeVideo_close(JNIEnv*, jclass, jlong handle) {
  delete reinterpret_cast<Video*>(handle);
}
