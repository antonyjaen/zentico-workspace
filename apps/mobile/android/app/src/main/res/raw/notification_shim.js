// Injected at document start into the workspace origin only (see MainActivity.installBridge).
// Replaces window.Notification with native Android notifications via the "zenticoNative" channel.
(function () {
  var native = window.zenticoNative;
  if (!native || window.top !== window) return;
  var live = new Map();
  var seq = 0;
  var permission = "default";
  var waiting = [];
  native.onmessage = function (e) {
    var m;
    try { m = JSON.parse(e.data); } catch (x) { return; }
    if (m.type === "permission") {
      permission = m.state;
      waiting.splice(0).forEach(function (cb) { cb(permission); });
    }
  };
  native.postMessage(JSON.stringify({ type: "permission" }));
  function fire(n, type) {
    var ev = new Event(type);
    n.dispatchEvent(ev);
    var h = n["on" + type];
    if (typeof h === "function") h.call(n, ev);
  }
  class ZenticoNotification extends EventTarget {
    static get permission() { return permission; }
    static requestPermission(cb) {
      return new Promise(function (resolve) {
        waiting.push(function (p) { if (typeof cb === "function") cb(p); resolve(p); });
        native.postMessage(JSON.stringify({ type: "permission", request: true }));
      });
    }
    constructor(title, options) {
      super();
      var o = options || {};
      this.title = String(title);
      this.body = o.body ? String(o.body) : "";
      this.tag = o.tag ? String(o.tag) : "";
      this.data = o.data;
      this.onclick = this.onshow = this.onclose = this.onerror = null;
      this._id = ++seq;
      live.set(this._id, this);
      if (live.size > 200) live.delete(live.keys().next().value);
      native.postMessage(JSON.stringify({ type: "notify", id: this._id, title: this.title, body: this.body }));
      var self = this;
      setTimeout(function () { fire(self, permission === "granted" ? "show" : "error"); }, 0);
    }
    close() { if (live.delete(this._id)) fire(this, "close"); }
  }
  window.__zenticoNotificationClick = function (id) {
    var n = live.get(id);
    if (n) fire(n, "click");
  };
  Object.defineProperty(window, "Notification", { value: ZenticoNotification, configurable: true, writable: true });
})();
