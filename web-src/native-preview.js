// 仅 APK 本机启用。远程网页和旧版本 APK 继续使用 MJPEG。
export const nativePreview = typeof HostControl !== 'undefined' &&
  typeof HostControl.nativePreview === 'function' && HostControl.nativePreview();

if (nativePreview) {
  const sync = () => {
    const items = [];
    const modal = !!document.querySelector('dialog[open]');
    document.querySelectorAll('img[data-native-channel]').forEach(img => {
      // 弹层遮住原生视频时保留一张背景截图；关闭后恢复直显。
      if (modal && !document.hidden && !img.hidden && img.getClientRects().length && !img.getAttribute('src'))
        img.src='/api/snapshot/'+img.dataset.nativeChannel+'.jpg';
      else if (!modal && img.getAttribute('src')) img.removeAttribute('src');
    });
    if (!document.hidden && !modal) {
      document.querySelectorAll('img[data-native-channel]').forEach(img => {
        if (img.hidden || !img.getClientRects().length) return;
        const r = img.getBoundingClientRect();
        if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) return;
        // 与 object-fit:contain 相同，不能拉伸或裁掉摄像头内容。
        const w = Math.min(r.width, r.height * 16 / 9), h = w * 9 / 16;
        const x=r.left+(r.width-w)/2, y=r.top+(r.height-h)/2;
        const buttons=Array.from(img.parentElement.querySelectorAll('.video-tools button')).filter(b=>b.getClientRects().length).map(b=>{
          const p=b.getBoundingClientRect();return {text:b.textContent,x:(p.left-x)/w,y:(p.top-y)/h,w:p.width/w,h:p.height/h};
        });
        items.push({id:Number(img.dataset.nativeChannel), x, y, w, h, buttons,
          radius:img.closest('.detail-fullscreen')?0:12,labels:img.classList.contains('camera-image')});
      });
    }
    HostControl.previewLayout(JSON.stringify({width:innerWidth,items}));
  };
  setInterval(sync, 250);
  addEventListener('resize', sync);
  document.addEventListener('visibilitychange', sync);
  document.addEventListener('click', () => setTimeout(sync, 0), true);
}
