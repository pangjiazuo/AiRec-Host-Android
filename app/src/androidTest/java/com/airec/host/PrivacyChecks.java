package com.airec.host;

import android.content.Context;
import android.graphics.*;
import android.media.*;
import android.opengl.*;
import android.view.Surface;
import com.airec.host.privacy.*;
import java.io.*;
import java.nio.*;

/** 使用外部公开测试图验证专用检测、共享 GPU 着色器及实际 MP4，不碰业务录像。 */
final class PrivacyChecks {
  static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }
  static FloatBuffer floats(float[] f) { FloatBuffer b = ByteBuffer.allocateDirect(f.length*4).order(ByteOrder.nativeOrder()).asFloatBuffer(); b.put(f).rewind(); return b; }
  static int shader(int type, String text) {
    int s = GLES20.glCreateShader(type); GLES20.glShaderSource(s, text); GLES20.glCompileShader(s);
    int[] result = new int[1]; GLES20.glGetShaderiv(s, GLES20.GL_COMPILE_STATUS, result, 0);
    check(result[0] != 0, GLES20.glGetShaderInfoLog(s)); return s;
  }
  static void run(Context context, String input, int flags) throws Exception {
    checkTracking();
    Bitmap original = BitmapFactory.decodeFile(input); check(original != null, "测试图不存在");
    Bitmap image = Bitmap.createScaledBitmap(original, 640, 360, true);
    ByteBuffer pixels = ByteBuffer.allocateDirect(640*360*4).order(ByteOrder.nativeOrder()); image.copyPixelsToBuffer(pixels); pixels.rewind();
    float[] boxes = NativePrivacy.detect(context, pixels, 640, 360, flags);
    check(boxes.length >= 4 && boxes.length % 4 == 0, "测试图没有检出隐私目标，flags=" + flags);
    for (float value : boxes) check(Float.isFinite(value) && value >= 0 && value <= 1, "检测区域越界");
    File output = new File(context.getCacheDir(), "privacy-check-" + flags + ".mp4");
    MediaCodec codec = MediaCodec.createEncoderByType("video/avc");
    String name = codec.getName(); check(name.toLowerCase().contains("rk") || name.toLowerCase().contains("rockchip"), "需验证硬件编码器：" + name);
    MediaFormat format = MediaFormat.createVideoFormat("video/avc", 640, 360);
    format.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
    format.setInteger(MediaFormat.KEY_BIT_RATE, 2000000); format.setInteger(MediaFormat.KEY_FRAME_RATE, 25); format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1);
    codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
    Surface surface = codec.createInputSurface(); codec.start();
    EGLDisplay display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY); int[] version = new int[2];
    check(EGL14.eglInitialize(display, version, 0, version, 1), "EGL 初始化失败");
    EGLConfig[] configs = new EGLConfig[1]; int[] count = new int[1];
    EGL14.eglChooseConfig(display, new int[]{EGL14.EGL_RED_SIZE,8,EGL14.EGL_GREEN_SIZE,8,EGL14.EGL_BLUE_SIZE,8,
      EGL14.EGL_ALPHA_SIZE,8,EGL14.EGL_RENDERABLE_TYPE,4,EGL14.EGL_SURFACE_TYPE,EGL14.EGL_WINDOW_BIT,0x3142,1,EGL14.EGL_NONE},0,configs,0,1,count,0);
    check(count[0]>0,"缺少编码 EGL 配置");
    EGLContext egl = EGL14.eglCreateContext(display,configs[0],EGL14.EGL_NO_CONTEXT,new int[]{EGL14.EGL_CONTEXT_CLIENT_VERSION,2,EGL14.EGL_NONE},0);
    EGLSurface window=EGL14.eglCreateWindowSurface(display,configs[0],surface,new int[]{EGL14.EGL_NONE},0);
    check(EGL14.eglMakeCurrent(display,window,window,egl), "EGL 绑定失败");
    int program=GLES20.glCreateProgram(); GLES20.glAttachShader(program,shader(GLES20.GL_VERTEX_SHADER,PrivacyShader.VERTEX));
    GLES20.glAttachShader(program,shader(GLES20.GL_FRAGMENT_SHADER,PrivacyShader.FRAGMENT)); GLES20.glLinkProgram(program);
    int[] linked=new int[1];GLES20.glGetProgramiv(program,GLES20.GL_LINK_STATUS,linked,0);check(linked[0]!=0,GLES20.glGetProgramInfoLog(program));
    GLES20.glUseProgram(program); int[] textures=new int[1];GLES20.glGenTextures(1,textures,0);GLES20.glBindTexture(GLES20.GL_TEXTURE_2D,textures[0]);
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D,GLES20.GL_TEXTURE_MIN_FILTER,GLES20.GL_NEAREST);
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D,GLES20.GL_TEXTURE_MAG_FILTER,GLES20.GL_NEAREST);
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D,GLES20.GL_TEXTURE_WRAP_S,GLES20.GL_CLAMP_TO_EDGE);
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D,GLES20.GL_TEXTURE_WRAP_T,GLES20.GL_CLAMP_TO_EDGE);
    // 使用与实际 AHD 输入相同的 YUYV 纹理，验证此分支也会把马赛克写入录像。
    ByteBuffer yuyv=ByteBuffer.allocateDirect(640*360*2);
    for(int y=0;y<360;y++)for(int x=0;x<640;x+=2){
      int a=image.getPixel(x,y),b=image.getPixel(x+1,y);
      int r=(Color.red(a)+Color.red(b))/2,g=(Color.green(a)+Color.green(b))/2,bl=(Color.blue(a)+Color.blue(b))/2;
      yuyv.put((byte)clamp(((66*Color.red(a)+129*Color.green(a)+25*Color.blue(a)+128)>>8)+16));
      yuyv.put((byte)clamp(((-38*r-74*g+112*bl+128)>>8)+128));
      yuyv.put((byte)clamp(((66*Color.red(b)+129*Color.green(b)+25*Color.blue(b)+128)>>8)+16));
      yuyv.put((byte)clamp(((112*r-94*g-18*bl+128)>>8)+128));
    }
    yuyv.rewind();GLES20.glTexImage2D(GLES20.GL_TEXTURE_2D,0,GLES20.GL_RGBA,320,360,0,GLES20.GL_RGBA,GLES20.GL_UNSIGNED_BYTE,yuyv);
    int pos=GLES20.glGetAttribLocation(program,"p"),uv=GLES20.glGetAttribLocation(program,"t");
    GLES20.glEnableVertexAttribArray(pos);GLES20.glVertexAttribPointer(pos,2,GLES20.GL_FLOAT,false,0,floats(new float[]{-1,-1,1,-1,-1,1,1,1}));
    GLES20.glEnableVertexAttribArray(uv);GLES20.glVertexAttribPointer(uv,2,GLES20.GL_FLOAT,false,0,floats(new float[]{0,1,1,1,0,0,1,0}));
    float[] matrix=new float[16];android.opengl.Matrix.setIdentityM(matrix,0);
    GLES20.glUniformMatrix4fv(GLES20.glGetUniformLocation(program,"m"),1,false,matrix,0);
    GLES20.glUniform4f(GLES20.glGetUniformLocation(program,"c"),0,0,1,1);
    GLES20.glUniform1f(GLES20.glGetUniformLocation(program,"sourceWidth"),640);
    GLES20.glUniform1i(GLES20.glGetUniformLocation(program,"rgbaMode"),0);
    GLES20.glUniform1i(GLES20.glGetUniformLocation(program,"maskCount"),boxes.length/4);
    GLES20.glUniform4fv(GLES20.glGetUniformLocation(program,"masks"),boxes.length/4,boxes,0);
    GLES20.glViewport(0,0,640,360);
    MediaMuxer mux=new MediaMuxer(output.getAbsolutePath(),MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
    MediaCodec.BufferInfo info=new MediaCodec.BufferInfo();int track=-1;int samples=0; boolean ended=false;
    try {
      for(int n=0;n<25;n++){
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP,0,4);
        EGLExt.eglPresentationTimeANDROID(display,window,1000000000L+n*40000000L);
        check(EGL14.eglSwapBuffers(display,window),"编码提交失败");
        if(n==24)codec.signalEndOfInputStream();
        long deadline=android.os.SystemClock.elapsedRealtime()+5000;
        while(true){
          int index=codec.dequeueOutputBuffer(info,n==24?10000:0);
          if(index==MediaCodec.INFO_OUTPUT_FORMAT_CHANGED){track=mux.addTrack(codec.getOutputFormat());mux.start();}
          else if(index>=0){
            if(info.size>0&&(info.flags&MediaCodec.BUFFER_FLAG_CODEC_CONFIG)==0){check(track>=0,"缺少编码格式");ByteBuffer data=codec.getOutputBuffer(index);data.position(info.offset);data.limit(info.offset+info.size);mux.writeSampleData(track,data,info);samples++;}
            ended=(info.flags&MediaCodec.BUFFER_FLAG_END_OF_STREAM)!=0;codec.releaseOutputBuffer(index,false);if(ended)break;
          } else if(n<24) break;
          if(android.os.SystemClock.elapsedRealtime()>deadline)throw new AssertionError("编码超时");
        }
      }
      check(ended&&samples>10,"录像未完成");
    } finally {
      if(track>=0)mux.stop();mux.release();codec.stop();codec.release();
      EGL14.eglMakeCurrent(display,EGL14.EGL_NO_SURFACE,EGL14.EGL_NO_SURFACE,EGL14.EGL_NO_CONTEXT);
      EGL14.eglDestroySurface(display,window);EGL14.eglDestroyContext(display,egl);EGL14.eglTerminate(display);surface.release();
    }
    MediaMetadataRetriever reader=new MediaMetadataRetriever();reader.setDataSource(output.getAbsolutePath());
    Bitmap decoded=reader.getFrameAtTime(0,MediaMetadataRetriever.OPTION_CLOSEST_SYNC);reader.release();check(decoded!=null,"录像不可解码");
    // 解码后的目标区域必须与原图不同，且保留像素块内部的近似同色结构。
    double difference=0;int tested=0;int flat=0;
    for(int i=0;i<boxes.length;i+=4)for(int y=(int)(boxes[i+1]*360)+2;y<boxes[i+3]*360-3;y++)for(int x=(int)(boxes[i]*640)+2;x<boxes[i+2]*640-3;x++){
      int a=image.getPixel(x,y),b=decoded.getPixel(x,y);difference+=Math.abs(Color.red(a)-Color.red(b))+Math.abs(Color.green(a)-Color.green(b))+Math.abs(Color.blue(a)-Color.blue(b));tested++;
      if(x%16<13&&y%16<13){int c=decoded.getPixel(x+1,y);if(Math.abs(Color.red(b)-Color.red(c))+Math.abs(Color.green(b)-Color.green(c))+Math.abs(Color.blue(b)-Color.blue(c))<20)flat++;}
    }
    check(tested>0&&difference/tested>5,"录像中未检测到遮挡变化");check(flat>tested*.35,"录像中未保留马赛克像素块");
    try(FileOutputStream out=new FileOutputStream(new File(context.getCacheDir(),"privacy-check-"+flags+".jpg"))){decoded.compress(Bitmap.CompressFormat.JPEG,90,out);}
    System.out.println("PRIVACY_PASS flags="+flags+" boxes="+boxes.length/4+" encoder="+name+" samples="+samples+" delta="+difference/tested);
    decoded.recycle();if(image!=original)image.recycle();original.recycle();
  }
  static int clamp(int value) { return Math.max(0,Math.min(255,value)); }
  static void checkTracking() {
    ByteBuffer before=ByteBuffer.allocateDirect(160*90*4),after=ByteBuffer.allocateDirect(160*90*4);
    java.util.Random random=new java.util.Random(42);
    for(int n=0;n<160*90;n++){ before.putInt(0xff404040);after.putInt(0xff404040); }
    for(int y=25;y<55;y++)for(int x=45;x<80;x++){
      byte value=(byte)(32+random.nextInt(190));
      for(int k=0;k<3;k++){before.put((y*160+x)*4+k,value);after.put(((y+3)*160+x+6)*4+k,value);}
    }
    float[] region={45/160f,25/90f,80/160f,55/90f};
    float[] moved=NativePrivacy.track(before,after,160,90,region);
    check(Math.abs(moved[0]-51/160f)<.008 && Math.abs(moved[1]-28/90f)<.012,"逐帧跟踪未跟随移动目标");
    float[] stationary=NativePrivacy.track(before,before,160,90,region);
    check(Math.abs(stationary[0]-region[0])<.001,"静止目标产生漂移");
    float[] full=NativePrivacy.track(before,after,160,90,new float[]{0,0,1,1});
    check(full[0]==0&&full[2]==1,"全帧保护区域被移动");
    PrivacyTracker tracker=new PrivacyTracker(1);
    tracker.beginFrame().put((ByteBuffer)before.duplicate().clear()); tracker.finishFrame(10000);
    PrivacyFrame delayed=tracker.detectionFrame(); delayed.boxes=region; delayed.missing=false;
    tracker.beginFrame().put((ByteBuffer)after.duplicate().clear()); tracker.finishFrame(10040);
    delayed.done=true;
    tracker.beginFrame().put((ByteBuffer)after.duplicate().clear()); tracker.finishFrame(10080);
    PrivacyFrame aligned=tracker.output(10080,10080,250);
    check(aligned.boxes.length==4&&Math.abs(aligned.boxes[0]-51/160f)<.008,"延迟检测框未对齐当前画面");
    check(!tracker.output(12000,12000,250).error.isEmpty(),"检测过期未启用遮挡保护");
  }
}
