#include <jni.h>
#include <dlfcn.h>
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>
#include <thread>
#include <cmath>

// RockX 1.1 C ABI；接口说明：https://t.rock-chips.com/wiki/rockx_api_doc/
// SDK 二进制独立提供，不把厂商头文件复制到源码。
namespace {
struct ConfigItem { char key[32]; char value[256]; };
struct Config { ConfigItem items[8]; int count; };
struct Image { uint8_t* data; uint32_t size; uint8_t preallocated; int format; uint32_t width, height; };
struct Object { int id, category, left, top, right, bottom; float score; };
struct Objects { int count; Object items[128]; };
using Create = int (*)(void**, int, void*, size_t);
using Detect = int (*)(void*, Image*, Objects*, void*);
Create create = nullptr;
Detect faceDetect = nullptr, plateDetect = nullptr;
void* handles[2]{};
Config config{};
void fail(JNIEnv* env, const char* text) { env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), text); }
}

extern "C" JNIEXPORT void JNICALL Java_com_airec_host_privacy_NativePrivacy_init(JNIEnv* env, jclass, jstring path) {
  void* lib = dlopen("librockx.so", RTLD_NOW | RTLD_LOCAL);
  if (!lib) { fail(env, "缺少兼容的 RockX 运行库"); return; }
  create = reinterpret_cast<Create>(dlsym(lib, "rockx_create"));
  faceDetect = reinterpret_cast<Detect>(dlsym(lib, "rockx_face_detect"));
  plateDetect = reinterpret_cast<Detect>(dlsym(lib, "rockx_carplate_detect"));
  if (!create || !faceDetect || !plateDetect) { fail(env, "RockX 接口不兼容"); return; }
  const char* value = env->GetStringUTFChars(path, nullptr);
  snprintf(config.items[0].key, 32, "ROCKX_DATA_PATH");
  snprintf(config.items[0].value, 256, "%s", value); config.count = 1;
  env->ReleaseStringUTFChars(path, value);
}

extern "C" JNIEXPORT jfloatArray JNICALL Java_com_airec_host_privacy_NativePrivacy_run(JNIEnv* env, jclass, jobject rgba, jint width, jint height, jint flags) {
  auto* bytes = static_cast<uint8_t*>(env->GetDirectBufferAddress(rgba));
  if (!create || !bytes || width < 1 || height < 1 || width > 1920 || height > 1080 ||
      env->GetDirectBufferCapacity(rgba) < static_cast<jlong>(width)*height*4) {
    fail(env, "隐私检测输入无效"); return nullptr;
  }
  Image image{bytes, static_cast<uint32_t>(width*height*4), 1, 3,
              static_cast<uint32_t>(width), static_cast<uint32_t>(height)};
  std::vector<float> boxes;
  // 先在调用线程准备模型，两个独立句柄随后并行推理同一帧。
  for (int i = 0; i < 2; i++) {
    if (!(flags & (1 << i))) continue;
    if (!handles[i] && create(&handles[i], i == 0 ? 1 : 10, &config, sizeof(config)) != 0) {
      handles[i] = nullptr; fail(env, "隐私模型初始化失败"); return nullptr;
    }
  }
  Objects results[2]{};
  int status[2]{};
  auto detect = [&](int i) {
    Image input = image;
    status[i] = (i == 0 ? faceDetect : plateDetect)(handles[i], &input, &results[i], nullptr);
  };
  if ((flags & 3) == 3) {
    try {
      std::thread face([&] { detect(0); });
      detect(1);
      face.join();
    } catch (...) { fail(env, "隐私并行检测失败"); return nullptr; }
  } else if (flags & 1) detect(0);
  else if (flags & 2) detect(1);
  for (int i = 0; i < 2; i++) {
    if (!(flags & (1 << i))) continue;
    const Objects& result = results[i];
    if (status[i] != 0 || result.count < 0 || result.count > 128) {
      fail(env, "隐私模型推理失败"); return nullptr;
    }
    for (int n = 0; n < result.count; n++) {
      const Object& box = result.items[n];
      if (box.right <= box.left || box.bottom <= box.top) continue;
      // 适当扩边，覆盖检测框边缘；不使用事件置信度过滤隐私目标。
      float dx = (box.right - box.left) * .2f + 4, dy = (box.bottom - box.top) * .2f + 4;
      boxes.insert(boxes.end(), {std::max(0.f, (box.left-dx)/width), std::max(0.f, (box.top-dy)/height),
        std::min(1.f, (box.right+dx)/width), std::min(1.f, (box.bottom+dy)/height)});
    }
  }
  // 着色器最多32个区域，超出时整帧遮挡，不静默丢弃后面的目标。
  if (boxes.size() > 128) boxes = {0, 0, 1, 1};
  jfloatArray output = env->NewFloatArray(boxes.size());
  if (!boxes.empty()) env->SetFloatArrayRegion(output, 0, boxes.size(), boxes.data());
  return output;
}

// 在 160×90 小图上匹配目标内部纹理，不在 CPU 上处理整幅 720p 视频。
extern "C" JNIEXPORT jfloatArray JNICALL Java_com_airec_host_privacy_NativePrivacy_track(
    JNIEnv* env, jclass, jobject previous, jobject current, jint width, jint height, jfloatArray region) {
  auto* a = static_cast<uint8_t*>(env->GetDirectBufferAddress(previous));
  auto* b = static_cast<uint8_t*>(env->GetDirectBufferAddress(current));
  if (!a || !b || !region || env->GetArrayLength(region) != 4 || width < 16 || height < 16 ||
      env->GetDirectBufferCapacity(previous) < jlong(width)*height*4 ||
      env->GetDirectBufferCapacity(current) < jlong(width)*height*4) {
    fail(env,"隐私跟踪输入无效"); return nullptr;
  }
  float box[4]; env->GetFloatArrayRegion(region,0,4,box);
  for (float v:box) if (!std::isfinite(v) || v < 0 || v > 1) { fail(env,"隐私跟踪区域无效"); return nullptr; }
  if ((box[2]-box[0])*(box[3]-box[1]) > .95f) {
    jfloatArray output=env->NewFloatArray(4);env->SetFloatArrayRegion(output,0,4,box);return output;
  }
  int x0 = std::clamp(int((box[0]*.75f+box[2]*.25f)*width),0,width-1);
  int x1 = std::clamp(int((box[0]*.25f+box[2]*.75f)*width),x0,width-1);
  int y0 = std::clamp(int((box[1]*.75f+box[3]*.25f)*height),0,height-1);
  int y1 = std::clamp(int((box[1]*.25f+box[3]*.75f)*height),y0,height-1);
  auto gray=[&](uint8_t* image,int x,int y){ auto* p=image+(y*width+x)*4; return (77*p[0]+150*p[1]+29*p[2])>>8; };
  int xs[81],ys[81],values[81],count=0,min=255,max=0;
  for(int y=y0;y<=y1;y+=std::max(1,(y1-y0+1)/8))
    for(int x=x0;x<=x1 && count<81;x+=std::max(1,(x1-x0+1)/8)) {
      xs[count]=x;ys[count]=y;values[count]=gray(a,x,y);min=std::min(min,values[count]);max=std::max(max,values[count]);count++;
    }
  auto score=[&](int dx,int dy){
    if(x0+dx<0 || x1+dx>=width || y0+dy<0 || y1+dy>=height)return 1e6f;
    int sum=0;for(int n=0;n<count;n++)sum+=std::abs(values[n]-gray(b,xs[n]+dx,ys[n]+dy));
    return float(sum)/std::max(1,count)+.08f*(std::abs(dx)+std::abs(dy));
  };
  int bestX=0,bestY=0;float best=score(0,0);
  if(max-min>=12) {
    for(int dy=-8;dy<=8;dy++)for(int dx=-10;dx<=10;dx++){
      float value=score(dx,dy);if(value<best){best=value;bestX=dx;bestY=dy;}
    }
  }
  float dx=float(bestX)/width,dy=float(bestY)/height;
  // 匹配不可靠时扩大遮挡，等待专用定位模型校正；不直接删掉目标。
  float grow=best>32 ? .0125f : 0;
  if(grow>0)dx=dy=0;
  box[0]=std::clamp(box[0]+dx-grow,0.f,1.f);box[2]=std::clamp(box[2]+dx+grow,0.f,1.f);
  box[1]=std::clamp(box[1]+dy-grow,0.f,1.f);box[3]=std::clamp(box[3]+dy+grow,0.f,1.f);
  jfloatArray output=env->NewFloatArray(4);env->SetFloatArrayRegion(output,0,4,box);return output;
}
