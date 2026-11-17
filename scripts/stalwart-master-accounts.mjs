// Master-account delegation in Stalwart (1.1): gives each person's account on the master domain
// full access to the same person's accounts on the other organisation domains (same local part),
// through per-collection ACLs (JMAP `shareWith`): every mailbox, calendar and address book, plus the
// Drive. The delegated accounts then appear in the master's JMAP session (isPersonal: false), in IMAP
// under "Shared Folders/<address>/…", and in CalDAV/CardDAV discovery.
//
// Stalwart can't do owner-level delegation between two *users*: `memberGroupIds` only accepts
// Group accounts and an account's type can't be changed. So sending as the delegated address is
// NOT granted by this (Identity/* and EmailSubmission/* are owner-only).
//
// Default: read-only. Prints the exact JMAP calls it would send (grant + rollback) as JSON.
//   --apply      send the grant calls
//   --rollback   remove every grant to the master (computed from the live state)
//   --only=<local part>                 restrict to one person (e.g. --only=ana.torres)
//   --master-domain=<domain>            domain of the personal sign-ins (env MASTER_DOMAIN)
//   --domains=<domain>[,<domain>...]    domains whose accounts are delegated (env DELEGATED_DOMAINS)
//
// Runs inside the workspace container (Node 24, reaches Stalwart at http://stalwart:8080, or set
// STALWART_URL) with the recovery admin in STALWART_ADMIN ("user:password"), never on the command
// line. From the deploy/ directory (STALWART_RECOVERY_ADMIN lives in deploy/.env):
//   sudo sh -c 'STALWART_ADMIN=$(grep -E "^STALWART_RECOVERY_ADMIN=" .env | cut -d= -f2- | tr -d "\"") //     docker compose exec -T -e STALWART_ADMIN workspace node --input-type=module - //     --master-domain=example.com --domains=example.org,example.net [--apply|--rollback]' //     < ../scripts/stalwart-master-accounts.mjs

const argValue = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const MASTER_DOMAIN = (argValue("master-domain") ?? process.env.MASTER_DOMAIN ?? "example.com").trim().toLowerCase();
const DELEGATED_DOMAINS = (argValue("domains") ?? process.env.DELEGATED_DOMAINS ?? "example.org")
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter((d) => d && d !== MASTER_DOMAIN);
if (!DELEGATED_DOMAINS.length) throw new Error("Pass --domains=<domain>[,<domain>...] (other than the master domain)");
/** Shared/role mailboxes are never delegated; people keep separate sign-ins for them. */
const SKIP = new Set(["admin", "administrator", "postmaster", "abuse", "soporte", "facturas", "noreply", "no-reply"]);
const URL_BASE = process.env.STALWART_URL ?? "http://stalwart:8080";
/** Drive folder created (role "home") in a delegated account that has no top-level node yet. */
const HOME_NAME = "Drive";

const ADMIN_ACCOUNT = "d333333";
const CORE = "urn:ietf:params:jmap:core";
const USING = [
  CORE,
  "urn:ietf:params:jmap:mail",
  "urn:ietf:params:jmap:calendars",
  "urn:ietf:params:jmap:contacts",
  "urn:ietf:params:jmap:filenode",
];

// Every right of each type (Stalwart 1.1 jmap-proto `all_rights()`): owner-equivalent access.
const all = (keys) => Object.fromEntries(keys.map((k) => [k, true]));
const RIGHTS = {
  Mailbox: all([
    "mayReadItems", "mayAddItems", "mayRemoveItems", "maySetSeen", "maySetKeywords", "mayCreateChild",
    "mayRename", "maySubmit", "mayDelete", "mayShare", "maySetMetadata",
  ]),
  Calendar: all([
    "mayReadFreeBusy", "mayReadItems", "mayWriteAll", "mayWriteOwn", "mayUpdatePrivate", "mayRSVP",
    "mayShare", "mayDelete", "maySetMetadata",
  ]),
  AddressBook: all(["mayRead", "mayWrite", "mayDelete", "mayShare", "maySetMetadata"]),
  FileNode: all([
    "mayRead", "mayAddChildren", "mayRename", "mayDelete", "mayModifyContent", "mayShare", "maySetMetadata",
  ]),
};

const args = new Set(process.argv.slice(2));
const only = argValue("only")?.toLowerCase() ?? null;
const mode = args.has("--apply") ? "apply" : args.has("--rollback") ? "rollback" : "plan";
if (args.has("--apply") && args.has("--rollback")) throw new Error("Pick one of --apply / --rollback");

const cred = process.env.STALWART_ADMIN;
if (!cred || !cred.includes(":")) throw new Error("Set STALWART_ADMIN=user:password (see header)");
const auth = `Basic ${Buffer.from(cred).toString("base64")}`;

async function jmap(using, methodCalls) {
  const res = await fetch(`${URL_BASE}/jmap/`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ using, methodCalls }),
  });
  if (!res.ok) throw new Error(`JMAP HTTP ${res.status}`);
  const { methodResponses } = await res.json();
  const out = {};
  for (const [name, a, id] of methodResponses) {
    if (name === "error") throw new Error(`JMAP ${id}: ${a.type} ${a.description ?? ""}`);
    out[id] ??= a;
  }
  return out;
}

/** Pairs every master (user on MASTER_DOMAIN) with its same-local-part users on the other domains. */
async function pairs() {
  const r = await jmap([CORE, "urn:stalwart:jmap"], [
    ["x:Domain/get", { accountId: ADMIN_ACCOUNT, properties: ["name"] }, "d"],
    ["x:Account/get", { accountId: ADMIN_ACCOUNT, properties: ["name", "domainId", "emailAddress", "@type"] }, "a"],
  ]);
  const domainName = new Map(r.d.list.map((d) => [d.id, d.name.toLowerCase()]));
  const users = r.a.list
    .filter((a) => a["@type"] === "User")
    .map((a) => ({ id: a.id, local: a.name.toLowerCase(), domain: domainName.get(a.domainId), email: a.emailAddress }));
  const out = [];
  for (const m of users) {
    if (m.domain !== MASTER_DOMAIN || SKIP.has(m.local) || (only && m.local !== only)) continue;
    const delegated = users.filter((u) => u.local === m.local && DELEGATED_DOMAINS.includes(u.domain));
    if (delegated.length) out.push({ master: m, delegated });
  }
  return out;
}

const sharedWith = (item, masterId) => Object.keys(item.shareWith ?? {}).includes(masterId);
const fullyShared = (item, masterId, rights) =>
  Object.keys(rights).every((k) => item.shareWith?.[masterId]?.[k] === true);

async function collections(accountId) {
  const r = await jmap(USING, [
    ["Mailbox/get", { accountId, properties: ["name", "shareWith"] }, "m"],
    ["Calendar/get", { accountId, properties: ["name", "shareWith"] }, "c"],
    ["AddressBook/get", { accountId, properties: ["name", "shareWith"] }, "a"],
    ["FileNode/query", { accountId, filter: { isTopLevel: true } }, "fq"],
    [
      "FileNode/get",
      { accountId, "#ids": { resultOf: "fq", name: "FileNode/query", path: "/ids" }, properties: ["name", "role", "shareWith"] },
      "f",
    ],
  ]);
  return { Mailbox: r.m.list, Calendar: r.c.list, AddressBook: r.a.list, FileNode: r.f.list };
}

/** The grant (or rollback) calls for one delegated account, as one JMAP request. */
function callsFor(accountId, masterId, cols, grant) {
  const calls = [];
  for (const type of ["Mailbox", "Calendar", "AddressBook", "FileNode"]) {
    const update = {};
    for (const item of cols[type]) {
      if (grant ? fullyShared(item, masterId, RIGHTS[type]) : !sharedWith(item, masterId)) continue;
      update[item.id] = { [`shareWith/${masterId}`]: grant ? RIGHTS[type] : {} };
    }
    const create =
      grant && type === "FileNode" && !cols.FileNode.length
        ? { home: { "@type": "Directory", name: HOME_NAME, role: "home", shareWith: { [masterId]: RIGHTS.FileNode } } }
        : undefined;
    if (Object.keys(update).length || create) {
      calls.push([`${type}/set`, { accountId, ...(create && { create }), ...(Object.keys(update).length && { update }) }, type]);
    }
  }
  return calls;
}

function summarize(res) {
  const out = {};
  for (const [id, r] of Object.entries(res)) {
    out[id] = {
      created: Object.keys(r.created ?? {}),
      updated: Object.keys(r.updated ?? {}),
      notCreated: r.notCreated ?? undefined,
      notUpdated: r.notUpdated ?? undefined,
    };
  }
  return out;
}

const plan = [];
for (const { master, delegated } of await pairs()) {
  for (const d of delegated) {
    const cols = await collections(d.id);
    const grant = callsFor(d.id, master.id, cols, true);
    // Rollback as it will look after the grant: every listed item, plus the Drive folder the grant
    // creates (left in place, unshared — it may hold files by then; computed live by --rollback).
    const after = Object.fromEntries(
      Object.entries(cols).map(([type, list]) => [type, list.map((i) => ({ ...i, shareWith: { [master.id]: RIGHTS[type] } }))]),
    );
    const rollback = callsFor(d.id, master.id, after, false);
    if (!cols.FileNode.length) rollback.push(["FileNode/set", { accountId: d.id, update: { "<id of the created Drive folder>": { [`shareWith/${master.id}`]: {} } } }, "FileNode-home"]);
    plan.push({ master: master.email, masterId: master.id, delegated: d.email, accountId: d.id, cols, grant, rollback });
  }
}

if (mode === "plan") {
  console.log(
    JSON.stringify(
      {
        note: "Each `grant`/`rollback` entry is the methodCalls of one JMAP request; using = " + JSON.stringify(USING),
        pairs: plan.map(({ master, masterId, delegated, accountId, grant, rollback }) => ({ master, masterId, delegated, accountId, grant, rollback })),
      },
      null,
      2,
    ),
  );
} else {
  for (const p of plan) {
    const calls = mode === "apply" ? p.grant : callsFor(p.accountId, p.masterId, p.cols, false);
    if (!calls.length) {
      console.log(`${p.delegated} -> ${p.master}: nothing to ${mode === "apply" ? "grant" : "remove"}`);
      continue;
    }
    const res = await jmap(USING, calls);
    console.log(`${p.delegated} -> ${p.master}: ${JSON.stringify(summarize(res))}`);
  }
}
