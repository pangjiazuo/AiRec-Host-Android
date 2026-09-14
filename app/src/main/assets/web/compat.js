// 板载 Android 9 WebView 的兼容补丁；不要求用户更新系统组件。
if (!Element.prototype.replaceChildren) {
  [Element.prototype, DocumentFragment.prototype].forEach(function (proto) {
    proto.replaceChildren = function () {
      while (this.firstChild) this.removeChild(this.firstChild);
      for (var i = 0; i < arguments.length; i++) this.append(arguments[i]);
    };
  });
}
if (!Promise.allSettled) Promise.allSettled = function (items) {
  return Promise.all(items.map(function (item) {
    return Promise.resolve(item).then(function (value) { return {status: 'fulfilled', value: value}; },
      function (reason) { return {status: 'rejected', reason: reason}; });
  }));
};
// 主机屏幕优先留给摄像头；局域网浏览器沿用完整仪表盘。
if (location.hostname === '127.0.0.1') document.documentElement.classList.add('host-mode');
