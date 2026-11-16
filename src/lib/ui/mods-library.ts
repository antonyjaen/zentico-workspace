// Recommended mods library: official mods users can install from the gallery (with permission
// approval) or that recommended layouts / apps bring along. Same rules as mods.ts: plain
// HTML/CSS/JS, no network, data only through `zentico.*`, user content rendered with textContent.
// Scripts are String.raw literals (backslashes kept as written); none contains a backtick or "${".
import type { ModFiles } from "./mods";

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/** Shared look (same visual language as the built-in mods). */
const BASE_CSS = `html, body { height: 100%; }
* { box-sizing: border-box; }
button { font: inherit; font-size: 12px; padding: 4px 9px; border-radius: 7px; border: 1px solid var(--zw-line); background: var(--zw-sheet); color: var(--zw-ink-soft); cursor: pointer; }
button:hover { color: var(--zw-ink); border-color: var(--zw-ink-mute); }
button.go { background: var(--zw-accent); border-color: var(--zw-accent); color: #fff; }
button:disabled { opacity: .5; cursor: default; }
input, textarea, select { font: inherit; font-size: 12.5px; padding: 6px 9px; border-radius: 8px; border: 1px solid var(--zw-line); background: var(--zw-sheet); color: var(--zw-ink); outline: none; min-width: 0; }
input:focus, textarea:focus, select:focus { border-color: var(--zw-accent); }
textarea { resize: vertical; width: 100%; }
h2 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--zw-ink-mute); font-weight: 600; }
.muted { color: var(--zw-ink-mute); font-size: 12px; }
.empty { color: var(--zw-ink-mute); font-size: 12.5px; text-align: center; padding: 14px 6px; }
.panel { background: var(--zw-sheet-muted); border: 1px solid var(--zw-line); border-radius: var(--zw-radius, 12px); padding: 8px; }
.item { background: var(--zw-sheet); border: 1px solid var(--zw-line); border-radius: 9px; padding: 7px 8px; }
.ell { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row { display: flex; gap: 6px; align-items: center; }
.grow { flex: 1; min-width: 0; }
.badge { display: inline-block; font-size: 10.5px; font-weight: 600; padding: 1px 6px; border-radius: 99px; background: var(--zw-accent); color: #fff; }
.chip { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; font-size: 11.5px; padding: 2px 8px; border-radius: 99px; border: 1px solid var(--zw-line); background: var(--zw-sheet-muted); color: var(--zw-ink-soft); cursor: pointer; }
.chip:hover { color: var(--zw-ink); border-color: var(--zw-accent); }
.link { color: var(--zw-accent); cursor: pointer; font-size: 12px; background: none; border: 0; padding: 0; }
`;

/** Small DOM helpers prepended to every script. */
const HELPERS = String.raw`
var NL = String.fromCharCode(10);
function $(id) { return document.getElementById(id); }
function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; }
function btn(label, fn, cls, title) { var b = el("button", cls || "", label); b.type = "button"; if (title) b.title = title; b.onclick = fn; return b; }
function errText(e) { return String((e && e.message) || e); }
function pad(n) { return (n < 10 ? "0" : "") + n; }
function ymd(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function uid() { return Math.random().toString(36).slice(2, 10); }
function debounce(fn, ms) { var t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }
var ES = zentico.locale === "es";
`;

const page = (body: string, css: string, js: string) =>
  `${body}\n<style>\n${BASE_CSS}${css}</style>\n<script>\n(function () {\n${HELPERS}\n${js}\n})();\n</script>\n`;

/* ------------------------------------------------------------ kanban-links */

const KANBAN_BODY = `<div class="kb">
  <form id="add" class="row"><input id="new" class="grow" maxlength="300" autocomplete="off"><button type="submit" id="addBtn" class="go"></button></form>
  <div class="sel" id="sel" hidden><span id="selLabel" class="ell grow"></span></div>
  <div class="cols" id="cols"></div>
</div>`;

const KANBAN_CSS = `.kb { height: 100%; display: flex; flex-direction: column; gap: 8px; padding: 8px; }
.sel { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--zw-ink-mute); padding: 4px 8px; border: 1px dashed var(--zw-line); border-radius: 8px; }
.cols { flex: 1; min-height: 0; display: grid; grid-auto-flow: column; grid-auto-columns: minmax(160px, 1fr); gap: 8px; overflow-x: auto; }
.col { min-height: 0; display: flex; flex-direction: column; }
.col.over { border-color: var(--zw-accent); }
.col h2 { display: flex; justify-content: space-between; }
.cards { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; min-height: 40px; }
.card { cursor: grab; font-size: 12.5px; }
.card .t { overflow-wrap: anywhere; }
.card .chip { margin-top: 6px; }
.card .a { display: flex; gap: 4px; margin-top: 6px; justify-content: flex-end; }
.card .a button { padding: 1px 7px; font-size: 11.5px; }
`;

const KANBAN_JS = String.raw`
var T = ES
  ? { add: "Añadir", placeholder: "Nueva tarjeta…", cols: ["Por hacer", "En curso", "Hecho"], remove: "Borrar", link: "Enlazar selección", unlink: "Quitar enlace", selected: "Selección: ", noHref: "Este enlace no se puede abrir", kinds: { "mail.thread": "Correo", "chat.conversation": "Chat", "drive.file": "Archivo" } }
  : { add: "Add", placeholder: "New card…", cols: ["To do", "Doing", "Done"], remove: "Delete", link: "Link selection", unlink: "Remove link", selected: "Selected: ", noHref: "This link can't be opened", kinds: { "mail.thread": "Mail", "chat.conversation": "Chat", "drive.file": "File" } };
$("addBtn").textContent = T.add; $("new").placeholder = T.placeholder;
var names = Array.isArray(zentico.config.columns) && zentico.config.columns.length ? zentico.config.columns.slice(0, 6).map(String) : T.cols;
var board = names.map(function (n) { return { title: n, cards: [] }; });
var dragging = null, selection = null;

function save() { zentico.storage.set("board", board).catch(function (e) { zentico.ui.toast(errText(e)); }); }
function labelOf(l) { return (T.kinds[l.kind] || l.kind) + " · " + (l.label || l.id); }
function move(ci, i, to) {
  if (to < 0 || to >= board.length) return;
  var c = board[ci].cards.splice(i, 1)[0];
  board[to].cards.unshift(c); save(); render();
}
function render() {
  var root = $("cols"); root.textContent = "";
  board.forEach(function (col, ci) {
    var c = el("div", "col panel");
    var h = el("h2"); h.appendChild(el("span", "", col.title)); h.appendChild(el("span", "", col.cards.length));
    var list = el("div", "cards");
    c.ondragover = function (e) { e.preventDefault(); c.classList.add("over"); };
    c.ondragleave = function () { c.classList.remove("over"); };
    c.ondrop = function (e) { e.preventDefault(); c.classList.remove("over"); if (dragging) move(dragging[0], dragging[1], ci); dragging = null; };
    col.cards.forEach(function (card, i) {
      var k = el("div", "card item"); k.draggable = true;
      k.ondragstart = function () { dragging = [ci, i]; };
      k.appendChild(el("div", "t", card.text));
      if (card.link) {
        var chip = el("span", "chip ell", labelOf(card.link)); chip.title = card.link.label || card.link.id;
        chip.onclick = function () { if (card.link.href) zentico.ui.openApp(card.link.href); else zentico.ui.toast(T.noHref); };
        k.appendChild(chip);
      }
      var a = el("div", "a");
      var lb = card.link
        ? btn("⛓", function () { delete card.link; save(); render(); }, "", T.unlink)
        : btn("🔗", function () { if (!selection) return; card.link = { kind: selection.kind, id: selection.id, href: selection.href || "", label: selection.label || "" }; save(); render(); }, "", T.link);
      if (!card.link && !selection) lb.disabled = true;
      var l = btn("←", function () { move(ci, i, ci - 1); }); l.disabled = ci === 0;
      var r = btn("→", function () { move(ci, i, ci + 1); }); r.disabled = ci === board.length - 1;
      a.appendChild(lb); a.appendChild(l); a.appendChild(r); a.appendChild(btn("×", function () { col.cards.splice(i, 1); save(); render(); }, "", T.remove));
      k.appendChild(a); list.appendChild(k);
    });
    c.appendChild(h); c.appendChild(list); root.appendChild(c);
  });
}
$("add").onsubmit = function (e) {
  e.preventDefault();
  var text = $("new").value.trim();
  if (!text) return;
  board[0].cards.unshift({ id: uid(), text: text.slice(0, 300) });
  $("new").value = ""; save(); render();
};
zentico.on("selection", function (s) {
  selection = s && s.id ? s : null;
  $("sel").hidden = !selection;
  if (selection) $("selLabel").textContent = T.selected + labelOf(selection);
  render();
});
zentico.on("command", function (c) { if (c.id === "add-card") $("new").focus(); });
zentico.storage.get("board").then(function (v) {
  if (Array.isArray(v) && v.length) board = names.map(function (n, i) { return { title: n, cards: v[i] && Array.isArray(v[i].cards) ? v[i].cards : [] }; });
  render();
}, render);
render();
`;

/* ----------------------------------------------------------------- standup */

const STANDUP_BODY = `<div class="su">
  <div class="row"><strong id="title" class="grow"></strong><span id="date" class="muted"></span></div>
  <label><h2 id="lY"></h2><textarea id="y" rows="3" maxlength="4000"></textarea></label>
  <label><h2 id="lT"></h2><textarea id="t" rows="3" maxlength="4000"></textarea></label>
  <label><h2 id="lB"></h2><textarea id="b" rows="2" maxlength="4000"></textarea></label>
  <div class="row conv" id="convRow"><select id="conv" class="grow"></select></div>
  <div class="row conv" id="convSet" hidden><span id="convName" class="muted ell grow"></span><button type="button" id="convChange" class="link"></button></div>
  <div class="row"><button type="button" id="drive"></button><span class="grow"></span><button type="button" id="post" class="go"></button></div>
</div>`;

const STANDUP_CSS = `.su { padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.su strong { font-size: 13.5px; }
label { display: block; }
label h2 { margin-bottom: 4px; }
.conv { font-size: 12px; }
`;

const STANDUP_JS = String.raw`
var T = ES
  ? { title: "Standup", y: "Ayer", t: "Hoy", b: "Bloqueos", drive: "Guardar en Drive", post: "Publicar en el chat", pick: "Elige una conversación…", change: "cambiar", to: "Se publicará en: ", saved: "Guardado en Drive", posted: "Publicado en el chat", none: "Nada", needConv: "Elige una conversación primero", empty: "Escribe algo primero" }
  : { title: "Standup", y: "Yesterday", t: "Today", b: "Blockers", drive: "Save to Drive", post: "Post to chat", pick: "Choose a conversation…", change: "change", to: "Posting to: ", saved: "Saved to Drive", posted: "Posted to chat", none: "None", needConv: "Choose a conversation first", empty: "Write something first" };
var today = ymd(new Date());
$("title").textContent = T.title; $("date").textContent = today;
$("lY").textContent = T.y; $("lT").textContent = T.t; $("lB").textContent = T.b;
$("drive").textContent = T.drive; $("post").textContent = T.post; $("convChange").textContent = T.change;
var fixed = typeof zentico.config.conversationId === "string" && zentico.config.conversationId ? zentico.config.conversationId : "";
var conv = fixed, convs = [];

var saveDraft = debounce(function () {
  zentico.storage.set("draft", { date: today, y: $("y").value, t: $("t").value, b: $("b").value }).catch(function () {});
}, 600);
["y", "t", "b"].forEach(function (id) { $(id).oninput = saveDraft; });

function md() {
  function part(h, v) { return "## " + h + NL + NL + (v.trim() || "- " + T.none) + NL; }
  return "# " + T.title + " " + today + NL + NL + part(T.y, $("y").value) + NL + part(T.t, $("t").value) + NL + part(T.b, $("b").value);
}
function chatText() {
  function line(h, v) { return "*" + h + ":* " + (v.trim() || T.none); }
  return "**" + T.title + " " + today + "**" + NL + line(T.y, $("y").value) + NL + line(T.t, $("t").value) + NL + line(T.b, $("b").value);
}
function hasText() { return !!($("y").value.trim() || $("t").value.trim() || $("b").value.trim()); }

function showConv() {
  var found = convs.filter(function (c) { return c.id === conv; })[0];
  $("convRow").hidden = !!conv;
  $("convSet").hidden = !conv;
  $("convChange").hidden = !!fixed;
  if (conv) $("convName").textContent = T.to + (found ? (found.team ? found.team + " › " : "") + found.name : conv);
}
function fillSelect() {
  var s = $("conv"); s.textContent = "";
  var o = el("option", "", T.pick); o.value = ""; s.appendChild(o);
  convs.forEach(function (c) { var op = el("option", "", (c.team ? c.team + " › " : "") + c.name); op.value = c.id; s.appendChild(op); });
}
$("conv").onchange = function () { conv = $("conv").value; zentico.storage.set("conversationId", conv).catch(function () {}); showConv(); };
$("convChange").onclick = function () { conv = ""; zentico.storage.remove("conversationId").catch(function () {}); showConv(); };

$("drive").onclick = function () {
  if (!hasText()) return zentico.ui.toast(T.empty);
  var args = { name: "Standup " + today + ".md", content: md() };
  if (typeof zentico.config.folderId === "string" && zentico.config.folderId) args.folderId = zentico.config.folderId;
  var b = $("drive"); b.disabled = true;
  zentico.action("drive.writeText", args).then(function () { zentico.ui.toast(T.saved); }, function (e) { zentico.ui.toast(errText(e)); }).then(function () { b.disabled = false; });
};
$("post").onclick = function () {
  if (!hasText()) return zentico.ui.toast(T.empty);
  if (!conv) return zentico.ui.toast(T.needConv);
  var b = $("post"); b.disabled = true;
  zentico.action("chat.send", { conversationId: conv, body: chatText() }).then(function () { zentico.ui.toast(T.posted); }, function (e) { zentico.ui.toast(errText(e)); }).then(function () { b.disabled = false; });
};

zentico.storage.get("draft").then(function (d) {
  if (!d || typeof d !== "object") return;
  if (d.date === today) { $("y").value = d.y || ""; $("t").value = d.t || ""; $("b").value = d.b || ""; }
  else { $("y").value = d.t || ""; }
});
Promise.all([fixed ? Promise.resolve(fixed) : zentico.storage.get("conversationId"), zentico.query("chat.conversations", { limit: 50 }).catch(function () { return { items: [] }; })]).then(function (r) {
  if (!fixed && typeof r[0] === "string") conv = r[0];
  convs = (r[1] && r[1].items) || [];
  fillSelect(); showConv();
});
fillSelect(); showConv();
`;

/* ------------------------------------------------------------ meeting-prep */

const PREP_BODY = `<div class="mp">
  <div id="none" class="empty" hidden></div>
  <div id="main" hidden>
    <div class="ev panel">
      <div class="row"><strong id="evTitle" class="grow ell"></strong><span id="evIn" class="badge"></span></div>
      <div id="evWhen" class="muted"></div>
      <div class="row acts"><button type="button" id="join" class="go" hidden></button><button type="button" id="openEv"></button></div>
    </div>
    <h2 id="hPeople"></h2>
    <div id="people" class="list"></div>
    <h2 id="hDocs"></h2>
    <div id="docs" class="list"></div>
  </div>
</div>`;

const PREP_CSS = `.mp { padding: 10px; }
.ev { margin-bottom: 12px; }
.ev strong { font-size: 14px; }
.acts { margin-top: 8px; }
h2 { margin-top: 10px; }
.list { display: flex; flex-direction: column; gap: 6px; }
.person .who { font-weight: 600; font-size: 12.5px; }
.person .mail { font-size: 12px; color: var(--zw-ink-soft); cursor: pointer; padding: 2px 0; }
.person .mail:hover { color: var(--zw-accent); }
.doc { cursor: pointer; font-size: 12.5px; }
.doc:hover { border-color: var(--zw-accent); }
`;

const PREP_JS = String.raw`
var T = ES
  ? { none: "No hay reuniones en los próximos 7 días.", join: "Unirse", open: "Abrir", people: "Asistentes", docs: "Documentos relacionados", noMail: "Sin correos recientes", noDocs: "No se encontraron documentos", now: "ahora", inMin: function (n) { return "en " + n + " min"; }, inH: function (h, m) { return "en " + h + " h" + (m ? " " + m + " min" : ""); }, inD: function (d) { return "en " + d + " d"; } }
  : { none: "No meetings in the next 7 days.", join: "Join", open: "Open", people: "Attendees", docs: "Related documents", noMail: "No recent mail", noDocs: "No documents found", now: "now", inMin: function (n) { return "in " + n + " min"; }, inH: function (h, m) { return "in " + h + " h" + (m ? " " + m + " min" : ""); }, inD: function (d) { return "in " + d + " d"; } };
$("none").textContent = T.none; $("join").textContent = T.join; $("openEv").textContent = T.open;
$("hPeople").textContent = T.people; $("hDocs").textContent = T.docs;
var STOP = ["meeting", "reunion", "reunión", "sync", "weekly", "semanal", "call", "llamada", "with", "with", "para", "sobre", "about", "review", "the", "and", "con", "del", "los", "las", "una"];
var ev = null, seq = 0;
var fmt = new Intl.DateTimeFormat(zentico.locale, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
var tfmt = new Intl.DateTimeFormat(zentico.locale, { hour: "2-digit", minute: "2-digit" });

function parsePerson(s) {
  var m = /^(.*?)\s*<([^>]+)>/.exec(s);
  var email = m ? m[2] : s.replace(/\s*\(.*\)$/, "").trim();
  var name = m && m[1] ? m[1] : email;
  var st = /\(([^)]+)\)\s*$/.exec(s);
  return { name: name, email: email, status: st ? st[1] : "" };
}
function countdown() {
  if (!ev) return;
  var ms = Date.parse(ev.start) - Date.now();
  var min = Math.round(ms / 60000);
  $("evIn").textContent = min <= 0 ? T.now : min < 60 ? T.inMin(min) : min < 1440 ? T.inH(Math.floor(min / 60), min % 60) : T.inD(Math.round(min / 1440));
}
function keyword(title) {
  var words = (title || "").split(/[^\p{L}\p{N}]+/u).filter(function (w) { return w.length >= 4 && STOP.indexOf(w.toLowerCase()) < 0; });
  words.sort(function (a, b) { return b.length - a.length; });
  return words[0] || "";
}
function load() {
  var mine = ++seq;
  zentico.query("meetings.upcoming", { days: 7, limit: 1 }).then(function (r) {
    if (mine !== seq) return;
    ev = (r.events || [])[0] || null;
    $("none").hidden = !!ev; $("main").hidden = !ev;
    if (!ev) return;
    $("evTitle").textContent = ev.title || "—";
    $("evWhen").textContent = fmt.format(new Date(ev.start)) + " – " + tfmt.format(new Date(ev.end)) + (ev.location ? " · " + ev.location : "");
    $("join").hidden = !ev.meetHref;
    $("join").onclick = function () { zentico.ui.openApp(ev.meetHref); };
    $("openEv").onclick = function () { zentico.ui.openApp(ev.href); };
    countdown();
    var people = (ev.people || []).map(parsePerson).slice(0, 5);
    var box = $("people"); box.textContent = "";
    if (!people.length) box.appendChild(el("div", "muted", "—"));
    people.forEach(function (p) {
      var card = el("div", "item person");
      card.appendChild(el("div", "who ell", p.name + (p.status ? " · " + p.status : "")));
      var list = el("div", "muted", "…"); card.appendChild(list); box.appendChild(card);
      zentico.query("mail.search", { query: p.email, limit: 3 }).then(function (m) {
        list.textContent = ""; list.className = "";
        if (!(m.items || []).length) list.appendChild(el("div", "muted", T.noMail));
        (m.items || []).forEach(function (t) {
          var row = el("div", "mail ell", (t.subject || "—") + " · " + new Date(t.receivedAt).toLocaleDateString(zentico.locale));
          row.onclick = function () { zentico.ui.openApp(t.href); };
          list.appendChild(row);
        });
      }, function () { list.textContent = T.noMail; });
    });
    var docs = $("docs"); docs.textContent = "";
    var word = keyword(ev.title);
    if (!word) { docs.appendChild(el("div", "muted", T.noDocs)); return; }
    zentico.query("drive.search", { query: word, limit: 5 }).then(function (d) {
      docs.textContent = "";
      var items = (d.items || []).filter(function (x) { return !x.folder; });
      if (!items.length) docs.appendChild(el("div", "muted", T.noDocs));
      items.forEach(function (f) { var row = el("div", "item doc ell", f.name); row.onclick = function () { zentico.ui.openApp(f.href); }; docs.appendChild(row); });
    }, function () { docs.textContent = T.noDocs; });
  }, function (e) { $("none").hidden = false; $("main").hidden = true; $("none").textContent = errText(e); });
}
zentico.on("calendar", load);
setInterval(load, 5 * 60000);
setInterval(countdown, 30000);
load();
`;

/* ------------------------------------------------------------------ habits */

const HABITS_BODY = `<div class="hb">
  <section>
    <form id="addH" class="row"><input id="newH" class="grow" maxlength="60" autocomplete="off"><button type="submit" id="addHBtn" class="go"></button></form>
    <table id="grid"></table>
    <p id="emptyH" class="empty"></p>
  </section>
  <section class="panel">
    <div class="row"><h2 id="hChart" class="grow"></h2><span id="total" class="muted"></span></div>
    <svg id="chart" viewBox="0 0 280 60" preserveAspectRatio="none"></svg>
  </section>
  <section>
    <h2 id="hOkr"></h2>
    <form id="addO" class="row"><input id="newO" class="grow" maxlength="100" autocomplete="off"><button type="submit" id="addOBtn"></button></form>
    <div id="okrs"></div>
  </section>
</div>`;

const HABITS_CSS = `.hb { padding: 10px; display: flex; flex-direction: column; gap: 12px; }
table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 12.5px; }
th { font-size: 10.5px; font-weight: 600; color: var(--zw-ink-mute); text-transform: uppercase; padding: 2px; }
td { padding: 3px 2px; border-top: 1px solid var(--zw-line); text-align: center; }
td.name { text-align: left; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
td.streak { color: var(--zw-ink-mute); font-size: 11.5px; white-space: nowrap; }
.day { width: 22px; height: 22px; padding: 0; border-radius: 6px; }
.day.on { background: var(--zw-accent); border-color: var(--zw-accent); color: #fff; }
.x { border: 0; background: none; color: var(--zw-ink-mute); padding: 0 4px; }
#chart { width: 100%; height: 60px; display: block; margin-top: 4px; }
.okr { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-bottom: 1px solid var(--zw-line); font-size: 12.5px; }
.okr span.t { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.okr input[type=range] { width: 90px; padding: 0; accent-color: var(--zw-accent); }
.okr .pct { width: 34px; text-align: right; font-variant-numeric: tabular-nums; color: var(--zw-ink-soft); }
`;

const HABITS_JS = String.raw`
var T = ES
  ? { add: "Añadir", newH: "Nuevo hábito…", emptyH: "Añade un hábito para empezar.", chart: "Últimas 4 semanas", total: function (n) { return n + " completados"; }, okr: "Objetivos (OKR)", newO: "Nuevo objetivo…", streak: function (n) { return n + " d seguidos"; }, remove: "Quitar" }
  : { add: "Add", newH: "New habit…", emptyH: "Add a habit to get started.", chart: "Last 4 weeks", total: function (n) { return n + " done"; }, okr: "Objectives (OKRs)", newO: "New objective…", streak: function (n) { return n + "-day streak"; }, remove: "Remove" };
$("addHBtn").textContent = T.add; $("addOBtn").textContent = T.add; $("newH").placeholder = T.newH; $("newO").placeholder = T.newO;
$("emptyH").textContent = T.emptyH; $("hChart").textContent = T.chart; $("hOkr").textContent = T.okr;
var habits = [], okrs = [];
var SVGNS = "http://www.w3.org/2000/svg";
function daysBack(n) { var out = []; for (var i = n - 1; i >= 0; i--) { var d = new Date(); d.setDate(d.getDate() - i); out.push(d); } return out; }
function saveH() {
  var cutoff = ymd(daysBack(120)[0]);
  habits.forEach(function (h) { Object.keys(h.days).forEach(function (k) { if (k < cutoff) delete h.days[k]; }); });
  zentico.storage.set("habits", habits).catch(function (e) { zentico.ui.toast(errText(e)); });
}
var saveO = debounce(function () { zentico.storage.set("okrs", okrs).catch(function (e) { zentico.ui.toast(errText(e)); }); }, 400);
function streak(h) { var n = 0, d = new Date(); if (!h.days[ymd(d)]) d.setDate(d.getDate() - 1); while (h.days[ymd(d)] && n < 999) { n++; d.setDate(d.getDate() - 1); } return n; }
function renderGrid() {
  var t = $("grid"); t.textContent = "";
  var week = daysBack(7);
  var wd = new Intl.DateTimeFormat(zentico.locale, { weekday: "narrow" });
  var head = el("tr"); head.appendChild(el("th"));
  week.forEach(function (d) { var th = el("th", "", wd.format(d)); th.title = d.toLocaleDateString(zentico.locale); head.appendChild(th); });
  head.appendChild(el("th")); head.appendChild(el("th")); t.appendChild(head);
  habits.forEach(function (h, hi) {
    var tr = el("tr");
    var name = el("td", "name", h.name); name.title = h.name; tr.appendChild(name);
    week.forEach(function (d) {
      var key = ymd(d), td = el("td");
      var b = btn(h.days[key] ? "✓" : "", function () { if (h.days[key]) delete h.days[key]; else h.days[key] = true; saveH(); render(); }, "day" + (h.days[key] ? " on" : ""));
      td.appendChild(b); tr.appendChild(td);
    });
    tr.appendChild(el("td", "streak", T.streak(streak(h))));
    var x = el("td"); x.appendChild(btn("×", function () { habits.splice(hi, 1); saveH(); render(); }, "x", T.remove)); tr.appendChild(x);
    t.appendChild(tr);
  });
  t.hidden = !habits.length; $("emptyH").hidden = !!habits.length;
}
function renderChart() {
  var svg = $("chart"); while (svg.firstChild) svg.removeChild(svg.firstChild);
  var days = daysBack(28), counts = days.map(function (d) { var k = ymd(d); return habits.filter(function (h) { return h.days[k]; }).length; });
  var max = Math.max(1, habits.length), w = 280 / 28, total = 0;
  counts.forEach(function (c, i) {
    total += c;
    var h = Math.max(c ? 3 : 1, (c / max) * 56);
    var r = document.createElementNS(SVGNS, "rect");
    r.setAttribute("x", String(i * w + 1)); r.setAttribute("y", String(60 - h)); r.setAttribute("width", String(w - 2)); r.setAttribute("height", String(h)); r.setAttribute("rx", "1.5");
    r.setAttribute("fill", c ? "var(--zw-accent)" : "var(--zw-line)");
    var tt = document.createElementNS(SVGNS, "title"); tt.textContent = days[i].toLocaleDateString(zentico.locale) + ": " + c; r.appendChild(tt);
    svg.appendChild(r);
  });
  $("total").textContent = T.total(total);
}
function renderOkrs() {
  var box = $("okrs"); box.textContent = "";
  okrs.forEach(function (o, i) {
    var row = el("div", "okr");
    row.appendChild(el("span", "t", o.title));
    var r = document.createElement("input"); r.type = "range"; r.min = "0"; r.max = "100"; r.value = String(o.progress || 0);
    var pct = el("span", "pct", (o.progress || 0) + "%");
    r.oninput = function () { o.progress = Number(r.value); pct.textContent = o.progress + "%"; saveO(); };
    row.appendChild(r); row.appendChild(pct);
    row.appendChild(btn("×", function () { okrs.splice(i, 1); saveO(); renderOkrs(); }, "x", T.remove));
    box.appendChild(row);
  });
}
function render() { renderGrid(); renderChart(); }
$("addH").onsubmit = function (e) {
  e.preventDefault();
  var v = $("newH").value.trim(); if (!v) return;
  habits.push({ id: uid(), name: v.slice(0, 60), days: {} }); habits = habits.slice(0, 20);
  $("newH").value = ""; saveH(); render();
};
$("addO").onsubmit = function (e) {
  e.preventDefault();
  var v = $("newO").value.trim(); if (!v) return;
  okrs.push({ id: uid(), title: v.slice(0, 100), progress: 0 }); okrs = okrs.slice(0, 20);
  $("newO").value = ""; saveO(); renderOkrs();
};
Promise.all([zentico.storage.get("habits"), zentico.storage.get("okrs")]).then(function (r) {
  if (Array.isArray(r[0])) habits = r[0].filter(function (h) { return h && typeof h.name === "string"; }).map(function (h) { h.days = h.days && typeof h.days === "object" ? h.days : {}; return h; });
  if (Array.isArray(r[1])) okrs = r[1];
  render(); renderOkrs();
}, function () { render(); renderOkrs(); });
render(); renderOkrs();
`;

/* ----------------------------------------------------------- quick-capture */

const CAPTURE_BODY = `<div class="qc">
  <textarea id="text" rows="4" maxlength="20000"></textarea>
  <div class="row"><span id="hint" class="muted grow"></span><button type="button" id="drive"></button><button type="button" id="task" class="go"></button></div>
  <div class="row"><h2 id="hTasks" class="grow"></h2><button type="button" id="clear" class="link"></button></div>
  <ul id="list"></ul>
  <p id="empty" class="empty"></p>
</div>`;

const CAPTURE_CSS = `.qc { height: 100%; display: flex; flex-direction: column; gap: 8px; padding: 10px; }
.qc h2 { margin: 6px 0 0; }
ul { list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1; min-height: 0; }
li { display: flex; align-items: flex-start; gap: 8px; padding: 6px 2px; border-bottom: 1px solid var(--zw-line); font-size: 12.5px; }
li:last-child { border-bottom: 0; }
li span { flex: 1; min-width: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
li.done span { color: var(--zw-ink-mute); text-decoration: line-through; }
li input { margin-top: 2px; accent-color: var(--zw-accent); }
.x { border: 0; background: none; color: var(--zw-ink-mute); padding: 0 4px; }
`;

const CAPTURE_JS = String.raw`
var T = ES
  ? { placeholder: "Captura una idea, una tarea, una nota…", hint: "Ctrl/⌘ + Intro = tarea", drive: "Guardar en Drive", task: "Guardar como tarea", tasks: "Tareas", clear: "Quitar hechas", empty: "Sin tareas capturadas.", saved: "Guardado en Drive", remove: "Quitar", nothing: "Escribe algo primero" }
  : { placeholder: "Capture an idea, a task, a note…", hint: "Ctrl/⌘ + Enter = task", drive: "Save to Drive", task: "Save as task", tasks: "Tasks", clear: "Clear done", empty: "No captured tasks.", saved: "Saved to Drive", remove: "Remove", nothing: "Write something first" };
$("text").placeholder = T.placeholder; $("hint").textContent = T.hint; $("drive").textContent = T.drive; $("task").textContent = T.task;
$("hTasks").textContent = T.tasks; $("clear").textContent = T.clear; $("empty").textContent = T.empty;
var tasks = [];
function save() { zentico.storage.set("tasks", tasks).catch(function (e) { zentico.ui.toast(errText(e)); }); }
function render() {
  var ul = $("list"); ul.textContent = "";
  tasks.forEach(function (t, i) {
    var li = el("li", t.done ? "done" : "");
    var box = document.createElement("input"); box.type = "checkbox"; box.checked = !!t.done;
    box.onchange = function () { t.done = box.checked; save(); render(); };
    li.appendChild(box); li.appendChild(el("span", "", t.text));
    li.appendChild(btn("×", function () { tasks.splice(i, 1); save(); render(); }, "x", T.remove));
    ul.appendChild(li);
  });
  $("empty").hidden = !!tasks.length;
  $("clear").hidden = !tasks.some(function (t) { return t.done; });
}
function addTask() {
  var v = $("text").value.trim(); if (!v) return zentico.ui.toast(T.nothing);
  tasks.unshift({ id: uid(), text: v.slice(0, 1000), done: false, at: Date.now() }); tasks = tasks.slice(0, 200);
  $("text").value = ""; save(); render();
}
$("task").onclick = addTask;
$("text").onkeydown = function (e) { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); addTask(); } };
$("clear").onclick = function () { tasks = tasks.filter(function (t) { return !t.done; }); save(); render(); };
$("drive").onclick = function () {
  var v = $("text").value.trim(); if (!v) return zentico.ui.toast(T.nothing);
  var d = new Date(), b = $("drive"); b.disabled = true;
  zentico.action("drive.writeText", { name: "Capture " + ymd(d) + " " + pad(d.getHours()) + pad(d.getMinutes()) + ".md", content: v + NL })
    .then(function () { $("text").value = ""; zentico.ui.toast(T.saved); }, function (e) { zentico.ui.toast(errText(e)); })
    .then(function () { b.disabled = false; });
};
zentico.on("command", function (c) { if (c.id === "focus") $("text").focus(); });
zentico.storage.get("tasks").then(function (v) { if (Array.isArray(v)) tasks = v; render(); }, render);
render();
`;

/* -------------------------------------------------------------- team-pulse */

const PULSE_BODY = `<div class="tp">
  <div class="stats">
    <div class="panel"><div class="n" id="unread">–</div><div class="muted" id="lUnread"></div></div>
    <div class="panel"><div class="n" id="convs">–</div><div class="muted" id="lConvs"></div></div>
    <div class="panel"><div class="n" id="msgs">–</div><div class="muted" id="lMsgs"></div></div>
  </div>
  <div class="row"><h2 id="hActive" class="grow"></h2><span id="status" class="muted"></span></div>
  <div id="list" class="list"></div>
</div>`;

const PULSE_CSS = `.tp { padding: 10px; display: flex; flex-direction: column; gap: 10px; }
.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.stats .n { font-size: 22px; font-weight: 650; font-variant-numeric: tabular-nums; }
.list { display: flex; flex-direction: column; gap: 6px; }
.conv { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.conv:hover { border-color: var(--zw-accent); }
.conv .name { flex: 1; min-width: 0; font-size: 12.5px; font-weight: 600; }
.conv .cnt { font-size: 11.5px; color: var(--zw-ink-mute); font-variant-numeric: tabular-nums; white-space: nowrap; }
.conv svg { width: 72px; height: 22px; flex: none; }
`;

const PULSE_JS = String.raw`
var T = ES
  ? { unread: "sin leer", convs: "con novedades", msgs: "mensajes 24 h", active: "Más activas (24 h)", none: "Sin actividad en las últimas 24 h.", n: function (n) { return n + " msj"; }, failed: "No se pudo cargar el chat" }
  : { unread: "unread", convs: "with news", msgs: "messages 24 h", active: "Most active (24 h)", none: "No activity in the last 24 h.", n: function (n) { return n + " msg"; }, failed: "Couldn't load chat" };
$("lUnread").textContent = T.unread; $("lConvs").textContent = T.convs; $("lMsgs").textContent = T.msgs; $("hActive").textContent = T.active;
var SVGNS = "http://www.w3.org/2000/svg", busy = false, last = 0;
function spark(buckets) {
  var svg = document.createElementNS(SVGNS, "svg"); svg.setAttribute("viewBox", "0 0 72 22"); svg.setAttribute("preserveAspectRatio", "none");
  var max = Math.max.apply(null, buckets.concat([1])), w = 72 / buckets.length;
  buckets.forEach(function (c, i) {
    var h = c ? Math.max(2, (c / max) * 20) : 1;
    var r = document.createElementNS(SVGNS, "rect");
    r.setAttribute("x", String(i * w)); r.setAttribute("y", String(22 - h)); r.setAttribute("width", String(Math.max(1, w - 0.6))); r.setAttribute("height", String(h));
    r.setAttribute("fill", c ? "var(--zw-accent)" : "var(--zw-line)");
    svg.appendChild(r);
  });
  return svg;
}
function load() {
  if (busy) return; busy = true; last = Date.now();
  var since = Date.now() - 86400000;
  zentico.query("chat.conversations", { limit: 20 }).then(function (r) {
    var items = r.items || [];
    $("unread").textContent = String(items.reduce(function (a, c) { return a + (c.unread || 0); }, 0));
    $("convs").textContent = String(items.filter(function (c) { return c.unread > 0; }).length);
    var recent = items.filter(function (c) { return c.lastMessage && Date.parse(c.lastMessage.at) >= since; })
      .sort(function (a, b) { return Date.parse(b.lastMessage.at) - Date.parse(a.lastMessage.at); }).slice(0, 5);
    return Promise.all(recent.map(function (c) {
      return zentico.query("chat.messages", { conversationId: c.id, limit: 50 }).then(function (m) {
        var msgs = (m.items || []).filter(function (x) { return Date.parse(x.at) >= since; });
        var b = []; for (var i = 0; i < 24; i++) b.push(0);
        msgs.forEach(function (x) { var k = Math.min(23, Math.floor((Date.parse(x.at) - since) / 3600000)); if (k >= 0) b[k]++; });
        return { conv: c, count: msgs.length, buckets: b };
      }, function () { return { conv: c, count: 0, buckets: [] }; });
    }));
  }).then(function (rows) {
    rows = (rows || []).filter(function (x) { return x.count > 0; }).sort(function (a, b) { return b.count - a.count; });
    $("msgs").textContent = String(rows.reduce(function (a, x) { return a + x.count; }, 0));
    var list = $("list"); list.textContent = "";
    if (!rows.length) list.appendChild(el("div", "empty", T.none));
    rows.forEach(function (x) {
      var c = el("div", "item conv");
      c.appendChild(el("span", "name ell", (x.conv.team ? x.conv.team + " › " : "") + x.conv.name));
      if (x.conv.unread) c.appendChild(el("span", "badge", x.conv.unread));
      c.appendChild(spark(x.buckets));
      c.appendChild(el("span", "cnt", T.n(x.count)));
      c.onclick = function () { zentico.ui.openApp(x.conv.href); };
      list.appendChild(c);
    });
    $("status").textContent = "";
  }, function () { $("status").textContent = T.failed; }).then(function () { busy = false; });
}
zentico.on("chat", function () { if (Date.now() - last > 10000) load(); else setTimeout(load, 10000); });
setInterval(load, 3 * 60000);
load();
`;

/* --------------------------------------------------------------------- crm */

const CRM_BODY = `<div class="crm">
  <aside class="panel">
    <input id="q" autocomplete="off" maxlength="100">
    <h2 id="hList"></h2>
    <div id="list" class="list"></div>
  </aside>
  <main id="detail">
    <p id="pick" class="empty"></p>
    <div id="card" hidden>
      <div class="row"><strong id="name" class="grow ell"></strong><select id="stage"></select></div>
      <div id="sub" class="muted"></div>
      <div id="emails" class="chips"></div>
      <h2 id="hNotes"></h2>
      <textarea id="notes" rows="5" maxlength="20000"></textarea>
      <div class="row"><span id="savedAt" class="muted grow"></span><button type="button" id="unpin" class="link"></button></div>
      <h2 id="hMail"></h2>
      <div id="threads" class="list"></div>
    </div>
  </main>
</div>`;

const CRM_CSS = `.crm { height: 100%; display: grid; grid-template-columns: minmax(150px, 2fr) 3fr; gap: 8px; padding: 8px; }
aside { min-height: 0; display: flex; flex-direction: column; gap: 8px; }
aside h2 { margin: 2px 0 0; }
.list { display: flex; flex-direction: column; gap: 5px; overflow-y: auto; min-height: 0; }
.person { cursor: pointer; }
.person:hover, .person.on { border-color: var(--zw-accent); }
.person .n { font-size: 12.5px; font-weight: 600; }
.person .e { font-size: 11.5px; color: var(--zw-ink-mute); }
main { min-height: 0; overflow-y: auto; padding: 4px 2px; }
#card strong { font-size: 14.5px; }
#card h2 { margin-top: 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.th { display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 12.5px; }
.th:hover { border-color: var(--zw-accent); }
.th .s { flex: 1; min-width: 0; }
.th.unread .s { font-weight: 600; }
`;

const CRM_JS = String.raw`
var T = ES
  ? { search: "Buscar contactos…", pinned: "Con notas", results: "Resultados", pick: "Busca un contacto o elige uno con notas.", noPinned: "Aún no hay contactos con notas.", noResults: "Sin resultados.", notes: "Notas", mail: "Correos recientes", noMail: "Sin correos.", open: "Abrir", unpin: "Borrar notas", saved: "Guardado ", stages: { lead: "Lead", qualified: "Cualificado", proposal: "Propuesta", won: "Ganado", lost: "Perdido" } }
  : { search: "Search contacts…", pinned: "With notes", results: "Results", pick: "Search for a contact or pick one with notes.", noPinned: "No contacts with notes yet.", noResults: "No results.", notes: "Notes", mail: "Recent mail", noMail: "No mail.", open: "Open", unpin: "Delete notes", saved: "Saved ", stages: { lead: "Lead", qualified: "Qualified", proposal: "Proposal", won: "Won", lost: "Lost" } };
$("q").placeholder = T.search; $("pick").textContent = T.pick; $("hNotes").textContent = T.notes; $("hMail").textContent = T.mail; $("unpin").textContent = T.unpin;
Object.keys(T.stages).forEach(function (k) { var o = el("option", "", T.stages[k]); o.value = k; $("stage").appendChild(o); });
var current = null, record = null, seq = 0;

function keyOf(email) { return ("contact:" + email.toLowerCase().replace("@", "/")).replace(/[^\w.:\-\/ ]/g, "_").slice(0, 100); }
function personRow(p, onPick) {
  var r = el("div", "item person" + (current && p.emails[0] === current.emails[0] ? " on" : ""));
  r.appendChild(el("div", "n ell", p.name || p.emails[0]));
  r.appendChild(el("div", "e ell", [p.emails[0], p.company].filter(Boolean).join(" · ")));
  r.onclick = function () { onPick(p); };
  return r;
}
function showList(title, people, emptyText) {
  $("hList").textContent = title;
  var list = $("list"); list.textContent = "";
  if (!people.length) list.appendChild(el("div", "empty", emptyText));
  people.forEach(function (p) { list.appendChild(personRow(p, open)); });
}
function loadPinned() {
  zentico.storage.keys().then(function (keys) {
    keys = keys.filter(function (k) { return k.indexOf("contact:") === 0; }).slice(0, 40);
    return Promise.all(keys.map(function (k) { return zentico.storage.get(k); }));
  }).then(function (recs) {
    if ($("q").value.trim()) return;
    var people = (recs || []).filter(Boolean).sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); })
      .map(function (r) { return { name: r.name, emails: [r.email], company: r.company || null, stage: r.stage }; });
    showList(T.pinned, people, T.noPinned);
  }, function () { showList(T.pinned, [], T.noPinned); });
}
var search = debounce(function () {
  var q = $("q").value.trim(), mine = ++seq;
  if (!q) return loadPinned();
  zentico.query("contacts.search", { query: q, limit: 20 }).then(function (r) {
    if (mine !== seq) return;
    showList(T.results, (r.items || []).filter(function (p) { return p.emails && p.emails.length; }), T.noResults);
  }, function (e) { showList(T.results, [], errText(e)); });
}, 300);
$("q").oninput = search;

var saveRecord = debounce(function () {
  if (!current || !record) return;
  record.notes = $("notes").value.slice(0, 20000); record.stage = $("stage").value; record.updated = Date.now();
  zentico.storage.set(keyOf(current.emails[0]), record).then(function () {
    $("savedAt").textContent = T.saved + new Date().toLocaleTimeString(zentico.locale, { hour: "2-digit", minute: "2-digit" });
    if (!$("q").value.trim()) loadPinned();
  }, function (e) { zentico.ui.toast(errText(e)); });
}, 700);
$("notes").oninput = saveRecord; $("stage").onchange = saveRecord;
$("unpin").onclick = function () {
  if (!current) return;
  zentico.storage.remove(keyOf(current.emails[0])).then(function () { $("notes").value = ""; record = { email: current.emails[0], name: current.name, company: current.company, stage: "lead", notes: "" }; $("stage").value = "lead"; loadPinned(); });
};

function open(p) {
  current = p; var email = p.emails[0];
  $("pick").hidden = true; $("card").hidden = false;
  $("name").textContent = p.name || email;
  $("sub").textContent = [p.title, p.company].filter(Boolean).join(" · ");
  var chips = $("emails"); chips.textContent = "";
  p.emails.forEach(function (e) { chips.appendChild(el("span", "chip", e)); });
  $("notes").value = ""; $("savedAt").textContent = ""; $("stage").value = p.stage || "lead";
  zentico.storage.get(keyOf(email)).then(function (r) {
    record = r && typeof r === "object" ? r : { email: email, name: p.name, company: p.company, stage: "lead", notes: "" };
    $("notes").value = record.notes || ""; $("stage").value = record.stage || "lead";
  });
  var box = $("threads"); box.textContent = ""; box.appendChild(el("div", "muted", "…"));
  zentico.query("mail.search", { query: email, limit: 8 }).then(function (r) {
    box.textContent = "";
    if (!(r.items || []).length) box.appendChild(el("div", "muted", T.noMail));
    (r.items || []).forEach(function (t) {
      var row = el("div", "item th" + (t.unread ? " unread" : ""));
      row.appendChild(el("span", "s ell", t.subject || "—"));
      row.appendChild(el("span", "muted", new Date(t.receivedAt).toLocaleDateString(zentico.locale)));
      var o = btn(T.open, function (ev) { ev.stopPropagation(); zentico.ui.openApp(t.href); }, "link");
      row.appendChild(o);
      row.onclick = function () { zentico.ui.select("mail.thread", t.threadId, { href: t.href, label: t.subject }); };
      box.appendChild(row);
    });
  }, function (e) { box.textContent = errText(e); });
  var rows = $("list").children; for (var i = 0; i < rows.length; i++) rows[i].classList.remove("on");
}
loadPinned();
`;

/* ---------------------------------------------------------------- helpdesk */

const HELPDESK_BODY = `<div class="hd">
  <header class="row"><strong id="title"></strong><span id="query" class="chip"></span><span id="status" class="muted grow"></span><button type="button" id="refresh"></button></header>
  <div class="cols" id="cols"></div>
</div>`;

const HELPDESK_CSS = `.hd { height: 100%; display: flex; flex-direction: column; gap: 8px; padding: 8px; }
header strong { font-size: 13px; }
.cols { flex: 1; min-height: 0; display: grid; grid-auto-flow: column; grid-auto-columns: minmax(170px, 1fr); gap: 8px; overflow-x: auto; }
.col { min-height: 0; display: flex; flex-direction: column; }
.col.over { border-color: var(--zw-accent); }
.col h2 { display: flex; justify-content: space-between; }
.cards { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; min-height: 40px; }
.tk { cursor: grab; }
.tk .s { font-size: 12.5px; cursor: pointer; }
.tk .s:hover { color: var(--zw-accent); }
.tk.unread .s { font-weight: 650; }
.tk .f { font-size: 11.5px; color: var(--zw-ink-mute); }
.tk input { width: 100%; margin-top: 6px; font-size: 11.5px; padding: 3px 7px; }
.tk .a { display: flex; gap: 4px; margin-top: 6px; justify-content: flex-end; }
.tk .a button { padding: 1px 7px; font-size: 11.5px; }
`;

const HELPDESK_JS = String.raw`
var T = ES
  ? { title: "Soporte", refresh: "Actualizar", cols: ["Nuevos", "Asignados", "En espera", "Resueltos"], assignee: "Asignado a…", read: "Leído", open: "Abrir", count: function (n) { return n + " tickets"; }, failed: "No se pudo cargar el correo", none: "—", all: "todo el correo" }
  : { title: "Helpdesk", refresh: "Refresh", cols: ["New", "Assigned", "Waiting", "Done"], assignee: "Assignee…", read: "Read", open: "Open", count: function (n) { return n + " tickets"; }, failed: "Couldn't load mail", none: "—", all: "all mail" };
var q = typeof zentico.config.query === "string" ? zentico.config.query.trim() : "";
var names = Array.isArray(zentico.config.columns) && zentico.config.columns.length >= 2 ? zentico.config.columns.slice(0, 6).map(String) : T.cols;
var DONE = names.length - 1;
$("title").textContent = T.title; $("refresh").textContent = T.refresh; $("query").textContent = q || T.all;
var state = {}, threads = [], dragging = null;

function save() {
  var keys = Object.keys(state);
  var done = keys.filter(function (k) { return state[k].col === DONE; }).sort(function (a, b) { return (state[b].at || 0) - (state[a].at || 0); });
  done.slice(50).forEach(function (k) { delete state[k]; });
  zentico.storage.set("tickets", state).catch(function (e) { zentico.ui.toast(errText(e)); });
}
function entry(t) {
  var s = state[t.threadId];
  if (!s) s = state[t.threadId] = { col: 0, assignee: "" };
  s.subject = (t.subject || "").slice(0, 200); s.from = (t.from || "").slice(0, 120); s.href = t.href; s.at = s.at || Date.now();
  return s;
}
function moveTo(id, col) {
  var s = state[id]; if (!s || s.col === col) return;
  var prev = s.col; s.col = col; s.at = Date.now(); save(); render();
  if (col === DONE && prev !== DONE) zentico.action("mail.archive", { threadId: id }).catch(function (e) { zentico.ui.toast(errText(e)); });
}
function render() {
  var root = $("cols"); root.textContent = "";
  var live = {}; threads.forEach(function (t) { live[t.threadId] = t; entry(t); });
  var ids = Object.keys(state).filter(function (id) { return live[id] || state[id].col === DONE || state[id].col > 0; });
  names.forEach(function (name, ci) {
    var col = el("div", "col panel");
    var mine = ids.filter(function (id) { return Math.min(state[id].col, DONE) === ci; });
    var h = el("h2"); h.appendChild(el("span", "", name)); h.appendChild(el("span", "", mine.length));
    var list = el("div", "cards");
    col.ondragover = function (e) { e.preventDefault(); col.classList.add("over"); };
    col.ondragleave = function () { col.classList.remove("over"); };
    col.ondrop = function (e) { e.preventDefault(); col.classList.remove("over"); if (dragging) moveTo(dragging, ci); dragging = null; };
    mine.forEach(function (id) {
      var s = state[id], t = live[id];
      var c = el("div", "item tk" + (t && t.unread ? " unread" : "")); c.draggable = true;
      c.ondragstart = function () { dragging = id; };
      var subj = el("div", "s", s.subject || "—");
      subj.onclick = function () { zentico.ui.select("mail.thread", id, { href: s.href, label: s.subject }); };
      c.appendChild(subj); c.appendChild(el("div", "f ell", s.from || T.none));
      var a = document.createElement("input"); a.placeholder = T.assignee; a.value = s.assignee || ""; a.maxLength = 60;
      a.onchange = function () { s.assignee = a.value.trim(); if (s.assignee && s.col === 0) s.col = Math.min(1, DONE); save(); render(); };
      c.appendChild(a);
      var acts = el("div", "a");
      if (t && t.unread) acts.appendChild(btn(T.read, function () { zentico.action("mail.markRead", { threadId: id, read: true }).then(function () { t.unread = false; render(); }, function (e) { zentico.ui.toast(errText(e)); }); }));
      if (s.href) acts.appendChild(btn(T.open, function () { zentico.ui.openApp(s.href); }));
      var l = btn("←", function () { moveTo(id, ci - 1); }); l.disabled = ci === 0;
      var r = btn("→", function () { moveTo(id, ci + 1); }); r.disabled = ci === DONE;
      acts.appendChild(l); acts.appendChild(r); c.appendChild(acts);
      list.appendChild(c);
    });
    col.appendChild(h); col.appendChild(list); root.appendChild(col);
  });
}
function load() {
  var args = { limit: 40 }; if (q) args.query = q;
  zentico.query("mail.search", args).then(function (r) {
    threads = r.items || []; $("status").textContent = T.count(threads.length); render(); save();
  }, function () { $("status").textContent = T.failed; });
}
$("refresh").onclick = load;
zentico.on("mail", load);
zentico.storage.get("tickets").then(function (v) { if (v && typeof v === "object" && !Array.isArray(v)) state = v; load(); }, load);
setInterval(load, 3 * 60000);
`;

/* ------------------------------------------------------------ mcp-explorer */

const MCP_BODY = `<div class="mx">
  <div id="off" class="empty" hidden></div>
  <div id="on" hidden>
    <div class="row"><select id="server" class="grow"></select><button type="button" id="reload"></button></div>
    <div id="tools" class="list"></div>
    <div id="runner" class="panel" hidden>
      <div class="row"><strong id="tool" class="grow ell"></strong><span id="ro" class="badge" hidden></span></div>
      <div id="desc" class="muted"></div>
      <textarea id="args" rows="4" spellcheck="false"></textarea>
      <div class="row"><span id="err" class="muted grow"></span><button type="button" id="run" class="go"></button></div>
      <pre id="out"></pre>
    </div>
  </div>
</div>`;

const MCP_CSS = `.mx { padding: 10px; display: flex; flex-direction: column; gap: 8px; height: 100%; }
#on { display: flex; flex-direction: column; gap: 8px; min-height: 0; flex: 1; }
.list { display: flex; flex-wrap: wrap; gap: 5px; }
.list .chip.on { border-color: var(--zw-accent); color: var(--zw-ink); }
#runner { display: flex; flex-direction: column; gap: 6px; min-height: 0; }
#args { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
pre { margin: 0; max-height: 240px; overflow: auto; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--zw-ink-soft); }
#err { color: #d64545; }
`;

const MCP_JS = String.raw`
var T = ES
  ? { off: "No hay servidores MCP disponibles. Conecta uno en Ajustes y cambia \"example\" en el manifest.json de este mod por su identificador.", noTools: "Este servidor no tiene herramientas permitidas.", reload: "Actualizar", run: "Ejecutar", ro: "solo lectura", badJson: "Los argumentos no son JSON válido", running: "Ejecutando…", empty: "(sin resultado)" }
  : { off: "No MCP servers available. Connect one in Settings and change \"example\" in this mod's manifest.json to its slug.", noTools: "This server has no allowed tools.", reload: "Refresh", run: "Run", ro: "read-only", badJson: "Arguments are not valid JSON", running: "Running…", empty: "(no result)" };
$("reload").textContent = T.reload; $("run").textContent = T.run; $("ro").textContent = T.ro; $("args").value = "{}";
var servers = [], tool = null;

function offline(msg) { $("on").hidden = true; $("off").hidden = false; $("off").textContent = msg || T.off; }
function resultText(r) {
  if (r && Array.isArray(r.content)) {
    var parts = r.content.filter(function (c) { return c && c.type === "text"; }).map(function (c) { return c.text; });
    if (parts.length) return parts.join(NL + NL);
  }
  if (r && r.structuredContent) return JSON.stringify(r.structuredContent, null, 2);
  return r == null ? T.empty : JSON.stringify(r, null, 2);
}
function pickTool(t) {
  tool = t;
  $("runner").hidden = false; $("tool").textContent = t.name; $("desc").textContent = t.description || "";
  $("ro").hidden = !t.readOnly; $("out").textContent = ""; $("err").textContent = "";
  var chips = $("tools").children; for (var i = 0; i < chips.length; i++) chips[i].classList.toggle("on", chips[i].textContent === t.name);
}
function loadTools() {
  var id = $("server").value; tool = null; $("runner").hidden = true;
  var box = $("tools"); box.textContent = "";
  if (!id) return;
  zentico.mcp.listTools(id).then(function (tools) {
    box.textContent = "";
    if (!tools || !tools.length) box.appendChild(el("div", "muted", T.noTools));
    (tools || []).forEach(function (t) { var c = el("span", "chip", t.name); c.title = t.description || ""; c.onclick = function () { pickTool(t); }; box.appendChild(c); });
  }, function (e) { box.textContent = errText(e); });
}
function load() {
  zentico.mcp.listServers().then(function (list) {
    servers = list || [];
    if (!servers.length) return offline();
    $("off").hidden = true; $("on").hidden = false;
    var s = $("server"); s.textContent = "";
    servers.forEach(function (x) { var o = el("option", "", x.name || x.slug || x.id); o.value = x.id; s.appendChild(o); });
    loadTools();
  }, function (e) { offline(/not available/i.test(errText(e)) ? T.off : errText(e)); });
}
$("server").onchange = loadTools;
$("reload").onclick = load;
$("run").onclick = function () {
  if (!tool) return;
  var args;
  try { args = JSON.parse($("args").value || "{}"); } catch (e) { $("err").textContent = T.badJson; return; }
  $("err").textContent = ""; $("out").textContent = T.running;
  var b = $("run"); b.disabled = true;
  zentico.mcp.call($("server").value, tool.name, args).then(function (r) {
    $("out").textContent = resultText(r);
    if (r && r.isError) $("err").textContent = "isError";
  }, function (e) { $("out").textContent = ""; $("err").textContent = errText(e); }).then(function () { b.disabled = false; });
};
load();
`;

/* ----------------------------------------------------------------- library */

export const LIBRARY_MODS: Record<string, ModFiles> = {
  "kanban-links": {
    "manifest.json": json({
      name: "Kanban board",
      version: "1.1.0",
      description: "Kanban saved in the mod's storage. Drag cards between columns and link them to the mail, chat or file selected on the page.",
      entry: "index.html",
      icon: "kanban",
      permissions: [],
      commands: [{ id: "add-card", title: "Add a card" }],
      size: { w: 8, h: 10, height: 480 },
      config: { columns: [] },
    }),
    "index.html": page(KANBAN_BODY, KANBAN_CSS, KANBAN_JS),
  },
  standup: {
    "manifest.json": json({
      name: "Standup notes",
      version: "1.0.0",
      description: "Yesterday / Today / Blockers. Save the day's notes as Markdown in Drive and post them to a chat conversation.",
      entry: "index.html",
      icon: "clipboard-list",
      permissions: ["drive.write", "chat.read", "chat.send"],
      commands: [],
      size: { w: 4, h: 10, height: 460 },
      config: { conversationId: "", folderId: "" },
    }),
    "index.html": page(STANDUP_BODY, STANDUP_CSS, STANDUP_JS),
  },
  "meeting-prep": {
    "manifest.json": json({
      name: "Meeting prep",
      version: "1.0.0",
      description: "Your next meeting with a countdown, each attendee's recent mail threads and related Drive documents.",
      entry: "index.html",
      icon: "calendar-check",
      permissions: ["meetings.read", "calendar.read", "mail.read", "drive.read"],
      commands: [],
      size: { w: 4, h: 12, height: 520 },
      config: {},
    }),
    "index.html": page(PREP_BODY, PREP_CSS, PREP_JS),
  },
  habits: {
    "manifest.json": json({
      name: "Habits & OKRs",
      version: "1.0.0",
      description: "Daily habit check-offs with streaks and a 4-week chart, plus objectives with progress sliders.",
      entry: "index.html",
      icon: "target",
      permissions: [],
      commands: [],
      size: { w: 5, h: 12, height: 520 },
      config: {},
    }),
    "index.html": page(HABITS_BODY, HABITS_CSS, HABITS_JS),
  },
  "quick-capture": {
    "manifest.json": json({
      name: "Quick capture",
      version: "1.0.0",
      description: "Jot something down: keep it as a task or save it as a Markdown note in Drive.",
      entry: "index.html",
      icon: "pen-line",
      permissions: ["drive.write"],
      commands: [{ id: "focus", title: "Capture something" }],
      size: { w: 4, h: 9, height: 400 },
      config: {},
    }),
    "index.html": page(CAPTURE_BODY, CAPTURE_CSS, CAPTURE_JS),
  },
  "team-pulse": {
    "manifest.json": json({
      name: "Team pulse",
      version: "1.0.0",
      description: "Unread totals and the most active chat conversations of the last 24 hours, with hourly activity bars.",
      entry: "index.html",
      icon: "activity",
      permissions: ["chat.read"],
      commands: [],
      size: { w: 4, h: 9, height: 420 },
      config: {},
    }),
    "index.html": page(PULSE_BODY, PULSE_CSS, PULSE_JS),
  },
  crm: {
    "manifest.json": json({
      name: "CRM lite",
      version: "1.0.0",
      description: "Search your contacts, see their recent mail and keep a stage and notes per contact (saved in the mod's storage).",
      entry: "index.html",
      icon: "handshake",
      permissions: ["contacts.read", "mail.read"],
      commands: [],
      size: { w: 8, h: 12, height: 540 },
      config: {},
    }),
    "index.html": page(CRM_BODY, CRM_CSS, CRM_JS),
  },
  helpdesk: {
    "manifest.json": json({
      name: "Helpdesk board",
      version: "1.0.0",
      description: "Mail matching a query (e.g. to:support) as tickets on an assignment board: assign, move, mark read; moving to Done archives the conversation.",
      entry: "index.html",
      icon: "inbox",
      permissions: ["mail.read", "mail.modify"],
      commands: [],
      size: { w: 8, h: 12, height: 540 },
      config: { query: "to:support", columns: [] },
    }),
    "index.html": page(HELPDESK_BODY, HELPDESK_CSS, HELPDESK_JS),
  },
  "mcp-explorer": {
    "manifest.json": json({
      name: "MCP tools (example)",
      version: "1.0.0",
      description: 'Example of zentico.mcp: list a connected MCP server\'s tools and run them. Change "example" in "mcp" to the slug of one of your connected servers.',
      entry: "index.html",
      icon: "terminal",
      permissions: ["mcp"],
      mcp: [{ server: "example", tools: ["*"] }],
      commands: [],
      size: { w: 5, h: 10, height: 460 },
      config: {},
    }),
    "index.html": page(MCP_BODY, MCP_CSS, MCP_JS),
  },
};

/** Gallery cards of the library mods. */
export const LIBRARY_INFO: Record<string, { icon: string; name: { en: string; es: string }; description: { en: string; es: string } }> = {
  "kanban-links": {
    icon: "kanban",
    name: { en: "Kanban board", es: "Tablero kanban" },
    description: { en: "Drag cards between columns and link them to mail, chats or files.", es: "Arrastra tarjetas entre columnas y enlázalas a correos, chats o archivos." },
  },
  standup: {
    icon: "clipboard-list",
    name: { en: "Standup notes", es: "Notas de standup" },
    description: { en: "Yesterday / Today / Blockers, saved to Drive and posted to your team's chat.", es: "Ayer / Hoy / Bloqueos, guardado en Drive y publicado en el chat del equipo." },
  },
  "meeting-prep": {
    icon: "calendar-check",
    name: { en: "Meeting prep", es: "Preparar reunión" },
    description: { en: "Next meeting, attendees' recent mail and related documents in one place.", es: "La próxima reunión, el correo reciente de los asistentes y documentos relacionados." },
  },
  habits: {
    icon: "target",
    name: { en: "Habits & OKRs", es: "Hábitos y OKR" },
    description: { en: "Track daily habits with streaks and a chart, and objectives with progress.", es: "Sigue hábitos diarios con rachas y gráfico, y objetivos con su progreso." },
  },
  "quick-capture": {
    icon: "pen-line",
    name: { en: "Quick capture", es: "Captura rápida" },
    description: { en: "Write it down now: keep it as a task or save it to Drive.", es: "Apúntalo ya: guárdalo como tarea o en Drive." },
  },
  "team-pulse": {
    icon: "activity",
    name: { en: "Team pulse", es: "Pulso del equipo" },
    description: { en: "Unread chat and the most active conversations of the last 24 h.", es: "Chat sin leer y las conversaciones más activas de las últimas 24 h." },
  },
  crm: {
    icon: "handshake",
    name: { en: "CRM lite", es: "CRM ligero" },
    description: { en: "Contacts with their recent mail, a pipeline stage and notes.", es: "Contactos con su correo reciente, etapa comercial y notas." },
  },
  helpdesk: {
    icon: "inbox",
    name: { en: "Helpdesk board", es: "Tablero de soporte" },
    description: { en: "A shared-inbox query as tickets: assign, track and resolve.", es: "Una búsqueda del buzón compartido como tickets: asigna, sigue y resuelve." },
  },
  "mcp-explorer": {
    icon: "terminal",
    name: { en: "MCP tools (example)", es: "Herramientas MCP (ejemplo)" },
    description: { en: "Browse and run tools of a connected MCP server: a starting point for MCP-powered mods.", es: "Explora y ejecuta herramientas de un servidor MCP conectado: base para mods con MCP." },
  },
};
