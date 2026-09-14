#include <android/bitmap.h>
#include <jni.h>

#include <algorithm>
#include <cmath>
#include <fstream>
#include <string>
#include <vector>

#include "rknn_api.h"
struct Engine {
  rknn_context ctx = 0;
  rknn_tensor_attr attrs[3]{};
  std::vector<char> model;
  std::string version;
  ~Engine() {
    if (ctx) rknn_destroy(ctx);
  }
};
static void fail(JNIEnv* e, const std::string& text) {
  e->ThrowNew(e->FindClass("java/lang/IllegalStateException"), text.c_str());
}
extern "C" JNIEXPORT jlong JNICALL
Java_com_airec_host_detection_NativeDetector_open(JNIEnv* e, jclass,
                                                  jstring path) {
  const char* p = e->GetStringUTFChars(path, nullptr);
  std::ifstream in(p, std::ios::binary);
  e->ReleaseStringUTFChars(path, p);
  std::vector<char> model((std::istreambuf_iterator<char>(in)), {});
  if (model.empty()) {
    fail(e, "模型读取失败");
    return 0;
  }
  Engine* d = new Engine();
  d->model = std::move(model);
  int result = rknn_init(&d->ctx, d->model.data(), d->model.size(), 0);
  if (result < 0) {
    delete d;
    fail(e, "rknn_init 返回 " + std::to_string(result));
    return 0;
  }
  rknn_input_output_num count{};
  if (rknn_query(d->ctx, RKNN_QUERY_IN_OUT_NUM, &count, sizeof(count)) < 0 ||
      count.n_input != 1 || count.n_output != 3) {
    delete d;
    fail(e, "YOLO 输入输出数量不符");
    return 0;
  }
  for (int i = 0; i < 3; i++) {
    d->attrs[i].index = i;
    if (rknn_query(d->ctx, RKNN_QUERY_OUTPUT_ATTR, &d->attrs[i],
                   sizeof(d->attrs[i])) < 0) {
      delete d;
      fail(e, "无法查询 YOLO 输出");
      return 0;
    }
    int n = d->attrs[i].n_elems;
    if (n != 255 * 80 * 80 && n != 255 * 40 * 40 && n != 255 * 20 * 20) {
      delete d;
      fail(e, "YOLO 输出形状不符");
      return 0;
    }
  }
  rknn_sdk_version v{};
  rknn_query(d->ctx, RKNN_QUERY_SDK_VERSION, &v, sizeof(v));
  d->version = std::string(v.api_version) + " / " + v.drv_version;
  return reinterpret_cast<jlong>(d);
}
extern "C" JNIEXPORT jstring JNICALL
Java_com_airec_host_detection_NativeDetector_version(JNIEnv* e, jclass,
                                                     jlong ptr) {
  return e->NewStringUTF(reinterpret_cast<Engine*>(ptr)->version.c_str());
}
static int category(int cls) {
  if (cls == 0) return 0;
  if (cls == 1 || cls == 2 || cls == 3 || cls == 5 || cls == 6 || cls == 7)
    return 1;
  if (cls >= 14 && cls <= 23) return 2;
  return -1;
}
struct Box {
  float x1, y1, x2, y2, score;
  int label, cat;
};
extern "C" JNIEXPORT jfloatArray JNICALL
Java_com_airec_host_detection_NativeDetector_run(JNIEnv* e, jclass, jlong ptr,
                                                 jobject bitmap,
                                                 jfloat threshold) {
  Engine* d = reinterpret_cast<Engine*>(ptr);
  AndroidBitmapInfo bi{};
  if (AndroidBitmap_getInfo(e, bitmap, &bi) != 0 ||
      bi.format != ANDROID_BITMAP_FORMAT_RGBA_8888 || bi.width != 640 ||
      bi.height != 640) {
    fail(e, "输入必须为640 RGB位图");
    return nullptr;
  }
  void* pixels = nullptr;
  if (AndroidBitmap_lockPixels(e, bitmap, &pixels) != 0) {
    fail(e, "位图锁定失败");
    return nullptr;
  }
  std::vector<unsigned char> rgb(640 * 640 * 3);
  for (int y = 0; y < 640; y++)
    for (int x = 0; x < 640; x++) {
      auto* src = static_cast<unsigned char*>(pixels) + y * bi.stride + x * 4;
      auto* dst = rgb.data() + (y * 640 + x) * 3;
      dst[0] = src[0];
      dst[1] = src[1];
      dst[2] = src[2];
    }
  AndroidBitmap_unlockPixels(e, bitmap);
  rknn_input input{};
  input.buf = rgb.data();
  input.size = rgb.size();
  input.fmt = RKNN_TENSOR_NHWC;
  input.type = RKNN_TENSOR_UINT8;
  int ret = rknn_inputs_set(d->ctx, 1, &input);
  if (ret >= 0) ret = rknn_run(d->ctx, nullptr);
  if (ret < 0) {
    fail(e, "NPU 推理返回 " + std::to_string(ret));
    return nullptr;
  }
  rknn_output out[3]{};
  for (int i = 0; i < 3; i++) {
    out[i].index = i;
    out[i].want_float = 1;
  }
  ret = rknn_outputs_get(d->ctx, 3, out, nullptr);
  if (ret < 0) {
    fail(e, "NPU 输出返回 " + std::to_string(ret));
    return nullptr;
  }
  std::vector<Box> boxes;
  const float anchors[3][6] = {{10, 13, 16, 30, 33, 23},
                               {30, 61, 62, 45, 59, 119},
                               {116, 90, 156, 198, 373, 326}};
  for (int h = 0; h < 3; h++) {
    int side = int(std::sqrt(d->attrs[h].n_elems / 255));
    int scale = side == 80 ? 0 : side == 40 ? 1 : 2;
    int area = side * side;
    float stride = 640.f / side;
    float* p = static_cast<float*>(out[h].buf);
    bool nhwc = d->attrs[h].fmt == RKNN_TENSOR_NHWC;
    auto value = [&](int anchor, int component, int cell) {
      return p[nhwc ? cell * 255 + anchor * 85 + component
                    : (anchor * 85 + component) * area + cell];
    };
    for (int a = 0; a < 3; a++)
      for (int cell = 0; cell < area; cell++) {
        float objectness = value(a, 4, cell);
        if (!std::isfinite(objectness) || objectness < threshold) continue;
        int cls = 0;
        float score = 0;
        for (int k = 0; k < 80; k++) {
          float v = value(a, 5 + k, cell);
          if (v > score) {
            score = v;
            cls = k;
          }
        }
        score *= objectness;
        int cat = category(cls);
        if (score < threshold || cat < 0) continue;
        float x = (value(a, 0, cell) * 2 - .5f + cell % side) * stride,
              y = (value(a, 1, cell) * 2 - .5f + cell / side) * stride,
              w = std::pow(value(a, 2, cell) * 2, 2) * anchors[scale][a * 2],
              height = std::pow(value(a, 3, cell) * 2, 2) *
                       anchors[scale][a * 2 + 1];
        boxes.push_back({x - w / 2, y - height / 2, x + w / 2, y + height / 2,
                         score, cls, cat});
      }
  }
  rknn_outputs_release(d->ctx, 3, out);
  std::sort(boxes.begin(), boxes.end(),
            [](const Box& a, const Box& b) { return a.score > b.score; });
  if (boxes.size() > 1000) boxes.resize(1000);
  std::vector<float> result;
  std::vector<Box> kept;
  for (const Box& b : boxes) {
    bool suppress = false;
    for (const Box& a : kept) {
      if (a.label != b.label) continue;
      float intersection =
          std::max(0.f, std::min(a.x2, b.x2) - std::max(a.x1, b.x1)) *
          std::max(0.f, std::min(a.y2, b.y2) - std::max(a.y1, b.y1));
      float uni = (a.x2 - a.x1) * (a.y2 - a.y1) +
                  (b.x2 - b.x1) * (b.y2 - b.y1) - intersection;
      if (uni > 0 && intersection / uni > .45f) {
        suppress = true;
        break;
      }
    }
    if (suppress) continue;
    kept.push_back(b);
    result.insert(result.end(), {b.x1, b.y1, b.x2, b.y2, b.score,
                                 float(b.label), float(b.cat)});
    if (kept.size() >= 100) break;
  }
  jfloatArray array = e->NewFloatArray(result.size());
  e->SetFloatArrayRegion(array, 0, result.size(), result.data());
  return array;
}
extern "C" JNIEXPORT void JNICALL
Java_com_airec_host_detection_NativeDetector_close(JNIEnv*, jclass, jlong ptr) {
  delete reinterpret_cast<Engine*>(ptr);
}
