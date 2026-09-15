package com.airec.host.privacy;

/** GPU 像素化后统一送往显示、截图与硬件编码。 */
public final class PrivacyShader {
  public static final String VERTEX = "attribute vec2 p;attribute vec2 t;uniform mat4 m;uniform vec4 c;varying vec2 uv;varying vec2 localUv;void"
                + " main(){gl_Position=vec4(p,0.,1.);localUv=t;uv=(m*vec4(c.xy+t*c.zw,0.,1.)).xy;}";
  public static final String FRAGMENT = "precision highp float;uniform sampler2D image;uniform float sourceWidth;varying vec2"
                + " uv;varying vec2 localUv;uniform vec4 c;uniform mat4 m;uniform int rgbaMode;uniform int maskCount;uniform int blackout;uniform vec4 masks[32];"
                + " void main(){if(blackout==1){gl_FragColor=vec4(0.,0.,0.,1.);return;}vec2 q=localUv;for(int n=0;n<32;n++){if(n>=maskCount)break;"
                + " vec4 r=masks[n];if(q.x>=r.x&&q.x<=r.z&&q.y>=r.y&&q.y<=r.w){"
                + " q=(floor(q*vec2(40.,22.5))+.5)/vec2(40.,22.5);break;}}"
                + " if(rgbaMode==1){gl_FragColor=texture2D(image,q);return;}vec2 sampleUv=(m*vec4(c.xy+q*c.zw,0.,1.)).xy;float x=min(sourceWidth-1.,floor(sampleUv.x*sourceWidth));vec4"
                + " pair=texture2D(image,vec2((floor(x/2.)+.5)/(sourceWidth/2.),sampleUv.y));float"
                + " y=(mod(x,2.)<1.?pair.r:pair.b)-.062745;float u=pair.g-.501961;float"
                + " v=pair.a-.501961;gl_FragColor=vec4(1.164*y+1.596*v,1.164*y-.392*u-.813*v,1.164*y+2.017*u,1.);}";
}
