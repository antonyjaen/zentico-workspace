// Injected into the main frame of app windows (__ZENTICO_ORIGIN__ is replaced with the chosen
// workspace origin as a JSON string). On that origin only, it replaces
// window.Notification with a shim that shows native OS toasts through the `notify` command.
(function () {
  if (location.origin !== __ZENTICO_ORIGIN__ || window.top !== window) return;
  var ipc = window.__TAURI_INTERNALS__;
  if (!ipc || typeof ipc.invoke !== "function") return;
  var live = new Map();
  var seq = 0;
  function fire(n, type) {
    var ev = new Event(type);
    n.dispatchEvent(ev);
    var h = n["on" + type];
    if (typeof h === "function") h.call(n, ev);
  }
  class ZenticoNotification extends EventTarget {
    static get permission() {
      return "granted";
    }
    static requestPermission(cb) {
      if (typeof cb === "function") cb("granted");
      return Promise.resolve("granted");
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
      var self = this;
      ipc.invoke("notify", { id: this._id, title: this.title, body: this.body }).then(
        function () { fire(self, "show"); },
        function () { live.delete(self._id); fire(self, "error"); }
      );
    }
    close() {
      if (live.delete(this._id)) fire(this, "close");
    }
  }
  window.__zenticoNotificationClick = function (id) {
    var n = live.get(id);
    if (n) fire(n, "click");
  };
  Object.defineProperty(window, "Notification", { value: ZenticoNotification, configurable: true, writable: true });
})();
