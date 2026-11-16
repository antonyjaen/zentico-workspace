// Built-in example mods (files written into `Zentico UI/mods/<id>/` on first use or when a
// recommended layout needs them). They double as SDK examples for agents: plain HTML/CSS/JS, no
// network, data only through `zentico.*`. Keep them free of backticks and "${" (embedded in TS
// template literals) and render user content with textContent only.

export type ModFiles = Record<string, string>;

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/* -------------------------------------------------------------- pomodoro */

const POMODORO_HTML = `<div class="wrap">
  <section class="timer">
    <div class="mode" id="mode"></div>
    <div class="time" id="time">25:00</div>
    <div class="row">
      <button id="toggle" class="primary"></button>
      <button id="reset"></button>
      <button id="skip"></button>
    </div>
    <div class="count" id="count"></div>
  </section>
  <section class="tasks">
    <form id="add"><input id="new" maxlength="200" autocomplete="off"><button id="addBtn" type="submit"></button></form>
    <ul id="list"></ul>
    <p class="empty" id="empty"></p>
  </section>
</div>
<link rel="stylesheet" href="style.css">
<script src="app.js"></script>
`;

const POMODORO_CSS = `html, body { height: 100%; }
.wrap { height: 100%; display: flex; flex-direction: column; gap: 12px; padding: 10px; }
.timer { text-align: center; padding: 12px 8px 14px; border: 1px solid var(--zw-line); border-radius: var(--zw-radius, 12px); background: var(--zw-sheet-muted); }
.mode { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--zw-ink-mute); }
.time { font-size: 44px; font-weight: 650; letter-spacing: -.02em; font-variant-numeric: tabular-nums; margin: 4px 0 10px; }
.timer.break .time { color: var(--zw-accent); }
.row { display: flex; gap: 6px; justify-content: center; }
button { font: inherit; font-size: 12.5px; padding: 5px 11px; border-radius: 8px; border: 1px solid var(--zw-line); background: var(--zw-sheet); color: var(--zw-ink); cursor: pointer; }
button:hover { border-color: var(--zw-ink-mute); }
button.primary { background: var(--zw-accent); border-color: var(--zw-accent); color: #fff; }
.count { margin-top: 8px; font-size: 12px; color: var(--zw-ink-mute); }
.tasks { flex: 1; min-height: 0; display: flex; flex-direction: column; }
form { display: flex; gap: 6px; }
input { flex: 1; min-width: 0; font: inherit; padding: 6px 9px; border-radius: 8px; border: 1px solid var(--zw-line); background: var(--zw-sheet); color: var(--zw-ink); outline: none; }
input:focus { border-color: var(--zw-accent); }
ul { list-style: none; margin: 8px 0 0; padding: 0; overflow-y: auto; }
li { display: flex; align-items: center; gap: 8px; padding: 5px 4px; border-bottom: 1px solid var(--zw-line); }
li:last-child { border-bottom: 0; }
li span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
li.done span { color: var(--zw-ink-mute); text-decoration: line-through; }
li .x { border: 0; background: none; color: var(--zw-ink-mute); padding: 2px 6px; }
.empty { color: var(--zw-ink-mute); font-size: 12.5px; text-align: center; margin: 14px 0; }
`;

const POMODORO_JS = `(function () {
  var T = {
    en: { work: "Focus", brk: "Break", start: "Start", pause: "Pause", reset: "Reset", skip: "Skip", add: "Add", placeholder: "Add a task…", empty: "No tasks yet.", done: function (n) { return n + " focus session" + (n === 1 ? "" : "s") + " today"; }, breakTime: "Time for a break", backToWork: "Back to focus", remove: "Remove" },
    es: { work: "Foco", brk: "Descanso", start: "Empezar", pause: "Pausa", reset: "Reiniciar", skip: "Saltar", add: "Añadir", placeholder: "Añade una tarea…", empty: "Aún no hay tareas.", done: function (n) { return n + (n === 1 ? " sesión" : " sesiones") + " de foco hoy"; }, breakTime: "Hora de descansar", backToWork: "De vuelta al foco", remove: "Quitar" }
  }[zentico.locale === "es" ? "es" : "en"];
  function minutes(v, def, max) { v = Number(v); return v >= 1 && v <= max ? Math.round(v) : def; }
  var WORK = minutes(zentico.config.work, 25, 120) * 60;
  var BREAK = minutes(zentico.config.break, 5, 60) * 60;
  var today = new Date().toISOString().slice(0, 10);
  var state = { mode: "work", left: WORK, running: false, endsAt: 0, done: 0, day: today };
  var tasks = [];
  var $ = function (id) { return document.getElementById(id); };

  $("toggle").onclick = toggle;
  $("reset").onclick = reset;
  $("skip").onclick = function () { finish(true); };
  $("reset").textContent = T.reset;
  $("skip").textContent = T.skip;
  $("addBtn").textContent = T.add;
  $("new").placeholder = T.placeholder;
  $("empty").textContent = T.empty;

  function save() { zentico.storage.set("timer", state).catch(function () {}); }
  function saveTasks() { zentico.storage.set("tasks", tasks).catch(function (e) { zentico.ui.toast(String(e.message || e)); }); }
  function fmt(s) { var m = Math.floor(s / 60), r = s % 60; return (m < 10 ? "0" : "") + m + ":" + (r < 10 ? "0" : "") + r; }

  function render() {
    $("mode").textContent = state.mode === "work" ? T.work : T.brk;
    $("time").textContent = fmt(state.left);
    $("toggle").textContent = state.running ? T.pause : T.start;
    $("count").textContent = T.done(state.done);
    document.querySelector(".timer").className = "timer " + state.mode;
  }
  function toggle() {
    if (state.running) { state.left = Math.max(0, Math.round((state.endsAt - Date.now()) / 1000)); state.running = false; }
    else { state.endsAt = Date.now() + state.left * 1000; state.running = true; }
    save(); render();
  }
  function reset() { state.running = false; state.mode = "work"; state.left = WORK; save(); render(); }
  function finish(skipped) {
    state.running = false;
    if (state.mode === "work") { if (!skipped) state.done++; state.mode = "break"; state.left = BREAK; if (!skipped) zentico.ui.toast(T.breakTime); }
    else { state.mode = "work"; state.left = WORK; if (!skipped) zentico.ui.toast(T.backToWork); }
    save(); render();
  }
  setInterval(function () {
    if (!state.running) return;
    state.left = Math.max(0, Math.round((state.endsAt - Date.now()) / 1000));
    if (state.left === 0) finish(false); else render();
  }, 500);

  function renderTasks() {
    var ul = $("list");
    ul.textContent = "";
    tasks.forEach(function (t, i) {
      var li = document.createElement("li");
      if (t.done) li.className = "done";
      var box = document.createElement("input");
      box.type = "checkbox"; box.checked = !!t.done; box.style.flex = "0";
      box.onchange = function () { t.done = box.checked; saveTasks(); renderTasks(); };
      var span = document.createElement("span"); span.textContent = t.text;
      var x = document.createElement("button"); x.className = "x"; x.textContent = "×"; x.title = T.remove;
      x.onclick = function () { tasks.splice(i, 1); saveTasks(); renderTasks(); };
      li.appendChild(box); li.appendChild(span); li.appendChild(x); ul.appendChild(li);
    });
    $("empty").style.display = tasks.length ? "none" : "block";
  }
  $("add").onsubmit = function (e) {
    e.preventDefault();
    var text = $("new").value.trim();
    if (!text) return;
    tasks.unshift({ text: text.slice(0, 200), done: false });
    tasks = tasks.slice(0, 100);
    $("new").value = "";
    saveTasks(); renderTasks();
  };

  zentico.on("command", function (c) {
    if (c.id === "toggle") toggle();
    else if (c.id === "reset") reset();
    else if (c.id === "add-task") $("new").focus();
  });

  Promise.all([zentico.storage.get("timer"), zentico.storage.get("tasks")]).then(function (r) {
    var s = r[0];
    if (s && typeof s === "object") {
      state = Object.assign(state, s);
      if (state.day !== today) { state.day = today; state.done = 0; }
      if (state.running) {
        state.left = Math.max(0, Math.round((state.endsAt - Date.now()) / 1000));
        if (state.left === 0) finish(false);
      }
    }
    if (Array.isArray(r[1])) tasks = r[1];
    render(); renderTasks();
  }, function () { render(); renderTasks(); });
  render(); renderTasks();
})();
`;

/* ----------------------------------------------------------- inbox triage */

const TRIAGE_HTML = `<div class="board">
  <header><strong id="title"></strong><span id="status"></span><button id="refresh"></button></header>
  <div class="cols">
    <section><h2 id="hInbox"></h2><ul id="inbox"></ul></section>
    <section><h2 id="hLater"></h2><ul id="later"></ul></section>
  </div>
</div>
<style>
html, body { height: 100%; }
.board { height: 100%; display: flex; flex-direction: column; padding: 8px; gap: 8px; }
header { display: flex; align-items: center; gap: 8px; }
header strong { font-size: 13px; }
header span { flex: 1; font-size: 12px; color: var(--zw-ink-mute); }
.cols { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
section { min-height: 0; display: flex; flex-direction: column; background: var(--zw-sheet-muted); border: 1px solid var(--zw-line); border-radius: var(--zw-radius, 12px); padding: 8px; }
h2 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--zw-ink-mute); }
ul { list-style: none; margin: 0; padding: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
li { background: var(--zw-sheet); border: 1px solid var(--zw-line); border-radius: 9px; padding: 7px 8px; }
.from { font-weight: 600; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.subj { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.prev { font-size: 11.5px; color: var(--zw-ink-mute); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.acts { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
button { font: inherit; font-size: 11.5px; padding: 3px 8px; border-radius: 7px; border: 1px solid var(--zw-line); background: var(--zw-sheet); color: var(--zw-ink-soft); cursor: pointer; }
button:hover { color: var(--zw-ink); border-color: var(--zw-ink-mute); }
button.go { background: var(--zw-accent); border-color: var(--zw-accent); color: #fff; }
.empty { font-size: 12px; color: var(--zw-ink-mute); text-align: center; padding: 10px 0; }
</style>
<script>
(function () {
  var T = {
    en: { title: "Triage", inbox: "Unread", later: "Later", refresh: "Refresh", read: "Read", archive: "Archive", star: "Star", laterBtn: "Later", back: "Inbox", open: "Open", none: "Nothing here.", left: function (n) { return n + " unread"; }, failed: "Couldn't load mail" },
    es: { title: "Triaje", inbox: "Sin leer", later: "Luego", refresh: "Actualizar", read: "Leído", archive: "Archivar", star: "Destacar", laterBtn: "Luego", back: "Bandeja", open: "Abrir", none: "Nada por aquí.", left: function (n) { return n + " sin leer"; }, failed: "No se pudo cargar el correo" }
  }[zentico.locale === "es" ? "es" : "en"];
  var $ = function (id) { return document.getElementById(id); };
  $("title").textContent = T.title; $("hInbox").textContent = T.inbox; $("hLater").textContent = T.later; $("refresh").textContent = T.refresh;
  var inbox = [], later = [];

  function btn(label, fn, cls) { var b = document.createElement("button"); b.textContent = label; if (cls) b.className = cls; b.onclick = fn; return b; }
  function card(m, inLater) {
    var li = document.createElement("li");
    var f = document.createElement("div"); f.className = "from"; f.textContent = m.from || "?";
    var s = document.createElement("div"); s.className = "subj"; s.textContent = m.subject || "(no subject)";
    var p = document.createElement("div"); p.className = "prev"; p.textContent = m.preview || "";
    var a = document.createElement("div"); a.className = "acts";
    a.appendChild(btn(T.open, function () { zentico.ui.openApp(m.href); }));
    a.appendChild(btn(T.read, function () { act("mail.markRead", { threadId: m.threadId, read: true }, m); }));
    a.appendChild(btn(T.star, function () { act("mail.flag", { threadId: m.threadId, flagged: true }); }));
    a.appendChild(btn(T.archive, function () { act("mail.archive", { threadId: m.threadId }, m); }, "go"));
    if (inLater) a.appendChild(btn(T.back, function () { setLater(later.filter(function (x) { return x.threadId !== m.threadId; })); }));
    else a.appendChild(btn(T.laterBtn, function () { setLater([m].concat(later.filter(function (x) { return x.threadId !== m.threadId; })).slice(0, 50)); }));
    li.appendChild(f); li.appendChild(s); li.appendChild(p); li.appendChild(a);
    return li;
  }
  function fill(ul, list, inLater) {
    ul.textContent = "";
    if (!list.length) { var e = document.createElement("li"); e.className = "empty"; e.style.border = "0"; e.style.background = "none"; e.textContent = T.none; ul.appendChild(e); return; }
    list.forEach(function (m) { ul.appendChild(card(m, inLater)); });
  }
  function render() {
    var laterIds = later.map(function (m) { return m.threadId; });
    fill($("inbox"), inbox.filter(function (m) { return laterIds.indexOf(m.threadId) < 0; }), false);
    fill($("later"), later, true);
  }
  function setLater(list) { later = list; zentico.storage.set("later", later).catch(function () {}); render(); }
  function act(name, args, done) {
    zentico.action(name, args).then(function () {
      if (done) { inbox = inbox.filter(function (x) { return x.threadId !== done.threadId; }); if (name === "mail.archive") setLater(later.filter(function (x) { return x.threadId !== done.threadId; })); }
      render(); load();
    }, function (e) { zentico.ui.toast(String(e.message || e)); });
  }
  function load() {
    zentico.query("mail.search", { unreadOnly: true, limit: 30 }).then(function (r) {
      inbox = r.items || []; $("status").textContent = T.left(r.total || inbox.length); render();
    }, function () { $("status").textContent = T.failed; });
  }
  $("refresh").onclick = load;
  zentico.on("mail", load);
  zentico.storage.get("later").then(function (v) { if (Array.isArray(v)) later = v; render(); });
  load();
  setInterval(load, 120000);
})();
</script>
`;

/* ---------------------------------------------------------- mail actions */

const ACTIONS_HTML = `<div class="box">
  <p class="hint" id="hint"></p>
  <div id="main" hidden>
    <div class="subj" id="subj"></div>
    <div class="meta" id="meta"></div>
    <div class="grid">
      <button id="read"></button><button id="star"></button><button id="archive" class="go"></button>
    </div>
    <h3 id="hQuick"></h3>
    <div class="quick" id="quick"></div>
    <h3 id="hClaude"></h3>
    <button id="ask" class="wide"></button>
    <div class="out" id="out"></div>
  </div>
</div>
<style>
.box { padding: 10px; }
.hint { color: var(--zw-ink-mute); font-size: 12.5px; text-align: center; margin: 24px 6px; }
.subj { font-weight: 650; font-size: 14px; overflow-wrap: anywhere; }
.meta { color: var(--zw-ink-mute); font-size: 12px; margin: 2px 0 10px; }
.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--zw-ink-mute); margin: 14px 0 6px; }
.quick { display: flex; flex-direction: column; gap: 5px; }
button { font: inherit; font-size: 12.5px; padding: 6px 9px; border-radius: 8px; border: 1px solid var(--zw-line); background: var(--zw-sheet); color: var(--zw-ink); cursor: pointer; text-align: left; }
.grid button { text-align: center; }
button:hover { border-color: var(--zw-ink-mute); }
button.go { background: var(--zw-accent); border-color: var(--zw-accent); color: #fff; }
button.wide { width: 100%; }
button:disabled { opacity: .55; cursor: default; }
.out { font-size: 12.5px; white-space: pre-wrap; margin-top: 8px; color: var(--zw-ink-soft); }
</style>
<script>
(function () {
  var T = {
    en: { hint: "Select a conversation in a mail list (open in reader) to act on it here.", read: "Mark read", star: "Star", archive: "Archive", quick: "Quick replies", claude: "Claude", ask: "Ask Claude to draft a reply", asking: "Claude is writing a draft…", drafted: "Draft saved in Mail", messages: function (n) { return n + (n === 1 ? " message" : " messages"); },
      replies: ["Thanks! I'll take a look and get back to you.", "Received, thank you.", "Can we discuss this in a quick call this week?"] },
    es: { hint: "Selecciona una conversación en una lista de correo (abrir en lector) para actuar aquí.", read: "Marcar leído", star: "Destacar", archive: "Archivar", quick: "Respuestas rápidas", claude: "Claude", ask: "Pedir a Claude un borrador", asking: "Claude está escribiendo…", drafted: "Borrador guardado en Correo", messages: function (n) { return n + (n === 1 ? " mensaje" : " mensajes"); },
      replies: ["¡Gracias! Lo reviso y te digo algo.", "Recibido, gracias.", "¿Lo vemos en una llamada corta esta semana?"] }
  }[zentico.locale === "es" ? "es" : "en"];
  var $ = function (id) { return document.getElementById(id); };
  $("hint").textContent = T.hint; $("read").textContent = T.read; $("star").textContent = T.star; $("archive").textContent = T.archive;
  $("hQuick").textContent = T.quick; $("hClaude").textContent = T.claude; $("ask").textContent = T.ask;
  var replies = Array.isArray(zentico.config.replies) && zentico.config.replies.length ? zentico.config.replies.slice(0, 6).map(String) : T.replies;
  var thread = null;

  function fail(e) { zentico.ui.toast(String((e && e.message) || e)); }
  function run(name, args) { return zentico.action(name, args).catch(fail); }
  function show(t) {
    thread = t;
    $("hint").hidden = !!t; $("main").hidden = !t; $("out").textContent = "";
    if (!t) return;
    var last = t.messages[t.messages.length - 1] || {};
    $("subj").textContent = t.subject || "(no subject)";
    $("meta").textContent = (last.from && last.from[0] ? last.from[0] : "") + " · " + T.messages(t.messages.length);
    var q = $("quick"); q.textContent = "";
    replies.forEach(function (text) {
      var b = document.createElement("button"); b.textContent = text;
      b.onclick = function () { run("mail.draft", { replyToEmailId: last.emailId, body: text }).then(function (r) { if (r) zentico.ui.toast(T.drafted); }); };
      q.appendChild(b);
    });
  }
  $("read").onclick = function () { if (thread) run("mail.markRead", { threadId: thread.threadId, read: true }); };
  $("star").onclick = function () { if (thread) run("mail.flag", { threadId: thread.threadId, flagged: true }); };
  $("archive").onclick = function () { if (thread) run("mail.archive", { threadId: thread.threadId }).then(function (r) { if (r) show(null); }); };
  $("ask").onclick = function () {
    if (!thread) return;
    var b = $("ask"); b.disabled = true; $("out").textContent = T.asking;
    zentico.claude.ask("Draft a short reply to the mail thread " + thread.threadId + " (subject: " + JSON.stringify(thread.subject) + "). Read it with mail_get_thread and save the reply as a draft with mail_reply (do not send). Answer with the draft text.")
      .then(function (r) { $("out").textContent = r.text || ""; }, function (e) { $("out").textContent = ""; fail(e); })
      .then(function () { b.disabled = false; });
  };
  zentico.on("selection", function (s) {
    if (!s || s.kind !== "mail.thread") return;
    if (!s.id) return show(null);
    zentico.query("mail.thread", { threadId: s.id }).then(show, fail);
  });
  show(null);
})();
</script>
`;

/** Built-in mods by id: their files as written into the user's folder. */
export const BUILTIN_MODS: Record<string, ModFiles> = {
  pomodoro: {
    "manifest.json": json({
      name: "Pomodoro + tasks",
      version: "1.0.0",
      description: "A focus timer with a small task list. Everything is saved in the mod's own storage.",
      entry: "index.html",
      icon: "timer",
      permissions: [],
      commands: [
        { id: "toggle", title: "Start / pause the timer" },
        { id: "reset", title: "Reset the timer" },
        { id: "add-task", title: "Add a task" },
      ],
      size: { w: 4, h: 9, height: 420 },
      config: { work: 25, break: 5 },
    }),
    "index.html": POMODORO_HTML,
    "style.css": POMODORO_CSS,
    "app.js": POMODORO_JS,
  },
  "inbox-triage": {
    "manifest.json": json({
      name: "Inbox triage board",
      version: "1.0.0",
      description: "Unread mail as cards: mark read, star, archive, or park it in Later. Refreshes on new mail.",
      entry: "index.html",
      icon: "kanban",
      permissions: ["mail.read", "mail.modify"],
      commands: [],
      size: { w: 6, h: 10, height: 480 },
      config: {},
    }),
    "index.html": TRIAGE_HTML,
  },
  "mail-actions": {
    "manifest.json": json({
      name: "Mail quick actions",
      version: "1.0.0",
      description: "Acts on the conversation selected on the page: mark read, star, archive, quick reply drafts, or ask Claude for a draft.",
      entry: "index.html",
      icon: "zap",
      permissions: ["mail.read", "mail.modify", "mail.draft", "claude"],
      commands: [],
      size: { w: 3, h: 10, height: 420 },
      config: { replies: [] },
    }),
    "index.html": ACTIONS_HTML,
  },
};
