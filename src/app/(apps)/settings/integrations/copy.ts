// UI strings for Settings → Integrations (kept local so this page doesn't touch the shared
// message catalogs), plus the per-agent setup snippets and the paste-into-your-agent prompts.

/** What the setup prompt needs: the workspace URL, its MCP endpoint and the new token. */
export type PromptInput = { appUrl: string; endpoint: string; token: string };

/** The tabs of the agent picker. "mcp" = an editor or any MCP client; "api" = the bridge on an API key. */
export const SETUP_AGENTS = ["claude", "codex", "opencode", "gemini", "mcp", "api"] as const;
export type SetupAgent = (typeof SETUP_AGENTS)[number];
/** The CLIs that can set themselves up from a pasted prompt and run under the bridge. */
export type CliAgent = "claude" | "codex" | "opencode" | "gemini";
export const isCli = (a: SetupAgent): a is CliAgent => a === "claude" || a === "codex" || a === "opencode" || a === "gemini";

/** The env var the Codex / OpenCode / Gemini configs read the token from (keeps it out of config files). */
export const TOKEN_ENV = "ZENTICO_MCP_TOKEN";

/** Where each CLI keeps its MCP servers, and the config block for the workspace (token from TOKEN_ENV). */
export function mcpSnippet(agent: CliAgent | "cursor" | "vscode", endpoint: string, token: string): { file: string; code: string } {
  switch (agent) {
    case "claude":
      return { file: "", code: `claude mcp add --transport http zentico ${endpoint} --header "Authorization: Bearer ${token}" --scope user` };
    case "codex":
      return {
        file: "~/.codex/config.toml",
        code: `[mcp_servers.zentico]\nurl = "${endpoint}"\nbearer_token_env_var = "${TOKEN_ENV}"\ntool_timeout_sec = 180`,
      };
    case "opencode":
      return {
        file: "~/.config/opencode/opencode.json",
        code: JSON.stringify(
          {
            $schema: "https://opencode.ai/config.json",
            mcp: { zentico: { type: "remote", url: endpoint, enabled: true, oauth: false, headers: { Authorization: `Bearer {env:${TOKEN_ENV}}` } } },
          },
          null,
          2,
        ),
      };
    case "gemini":
      return {
        file: "~/.gemini/settings.json",
        code: JSON.stringify({ mcpServers: { zentico: { httpUrl: endpoint, headers: { Authorization: `Bearer $${TOKEN_ENV}` }, timeout: 180000 } } }, null, 2),
      };
    case "cursor":
      return {
        file: "~/.cursor/mcp.json",
        code: JSON.stringify({ mcpServers: { zentico: { url: endpoint, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
      };
    case "vscode":
      return {
        file: ".vscode/mcp.json",
        code: JSON.stringify(
          {
            servers: { zentico: { type: "http", url: endpoint, headers: { Authorization: "Bearer ${input:zentico-token}" } } },
            inputs: [{ type: "promptString", id: "zentico-token", description: "Zentico access token", password: true }],
          },
          null,
          2,
        ),
      };
  }
}

/** How to check the server shows up, per CLI. */
const LIST_CMD: Record<CliAgent, string> = { claude: "claude mcp list", codex: "codex mcp list", opencode: "opencode mcp list", gemini: "gemini mcp list" };
const LABEL: Record<CliAgent, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode", gemini: "Gemini CLI" };

/**
 * What the bridge can run: a CLI, an API family the bridge last reported (openai / anthropic), the
 * API tab's example (OpenRouter) or a custom command line.
 */
export type BridgeAgent = CliAgent | "openai" | "anthropic" | "api" | "custom";

/** The bridge's command line, always with an explicit --agent so it matches the user's agent. */
export function bridgeCommands(agent: BridgeAgent, appUrl: string, token: string): { unix: string; windows: string } {
  const extra =
    agent === "api"
      ? ["--agent", "openai", "--base-url", "https://openrouter.ai/api/v1", "--model", "openai/gpt-4.1-mini", "--api-key-env", "OPENROUTER_API_KEY"]
      : agent === "anthropic"
        ? ["--agent", "anthropic", "--model", "<model>", "--api-key-env", "ANTHROPIC_API_KEY"]
        : agent === "openai"
          ? ["--agent", "openai", "--model", "<model>"]
          : agent === "custom"
            ? ["--agent", "custom", "--custom", "<your command line>"]
            : ["--agent", agent];
  const unix = `mkdir -p ~/.zentico && curl -fsSL ${appUrl}/bridge.mjs -o ~/.zentico/zentico-bridge.mjs\nZENTICO_TOKEN=${token} nohup node ~/.zentico/zentico-bridge.mjs --url ${appUrl}${extra.map((a) => ` ${a}`).join("")} > ~/.zentico/bridge.log 2>&1 &`;
  const args = ["$HOME\\.zentico\\zentico-bridge.mjs", "--url", appUrl, ...extra].map((a) => `"${a}"`).join(",");
  const windows = `New-Item -ItemType Directory -Force "$HOME\\.zentico" | Out-Null; Invoke-WebRequest ${appUrl}/bridge.mjs -OutFile "$HOME\\.zentico\\zentico-bridge.mjs"\n$env:ZENTICO_TOKEN="${token}"; Start-Process node -ArgumentList ${args} -WindowStyle Hidden`;
  return { unix, windows };
}

const PROMPT_TEXT = {
  en: {
    intro: (label: string, appUrl: string) => `Connect my Zentico workspace (${appUrl}) to ${label}. Do the setup yourself, step by step:`,
    addClaude: "Add the Zentico MCP server for my user:",
    saveEnv: (token: string) =>
      `Save my access token in the user environment variable ${TOKEN_ENV}, so it persists (Windows: setx ${TOKEN_ENV} "${token}"; macOS / Linux: export it from my shell profile):\n   ${token}`,
    addConfig: (file: string) => `Add the Zentico MCP server to ${file} (create the file if needed; merge with what is there, keep my other settings):`,
    check: (cmd: string) => `Check with \`${cmd}\` that "zentico" shows up (open a new terminal first if the variable was just set).`,
    bridge: "Download the bridge that lets me ask you things from meetings, chat and the dashboard (needs Node 18+), and start it in the background so it keeps running after this session ends:",
    bridgeCheck: 'Check ~/.zentico/bridge.log (or the window) says "Connected as …".',
    done: (label: string) => `Tell me when it's ready, and remind me to restart ${label} to use the Zentico tools.`,
  },
  es: {
    intro: (label: string, appUrl: string) => `Conecta mi espacio de trabajo de Zentico (${appUrl}) a ${label}. Hazlo tú mismo, paso a paso:`,
    addClaude: "Añade el servidor MCP de Zentico para mi usuario:",
    saveEnv: (token: string) =>
      `Guarda mi token de acceso en la variable de entorno de usuario ${TOKEN_ENV}, de forma persistente (Windows: setx ${TOKEN_ENV} "${token}"; macOS / Linux: expórtala desde el perfil de mi shell):\n   ${token}`,
    addConfig: (file: string) => `Añade el servidor MCP de Zentico a ${file} (crea el archivo si hace falta; combínalo con lo que haya y conserva mis otros ajustes):`,
    check: (cmd: string) => `Comprueba con \`${cmd}\` que «zentico» aparece (abre antes una terminal nueva si la variable se acaba de crear).`,
    bridge: "Descarga el puente que me permite pedirte cosas desde reuniones, chat y el dashboard (necesita Node 18+) y arráncalo en segundo plano, de forma que siga activo cuando termine esta sesión:",
    bridgeCheck: "Comprueba que ~/.zentico/bridge.log (o la ventana) dice «Connected as …».",
    done: (label: string) => `Confírmame cuando esté listo y recuérdame que reinicie ${label} para usar las herramientas de Zentico.`,
  },
};

const indent = (s: string) => s.split("\n").map((l) => `   ${l}`).join("\n");

/** The prompt pasted into a CLI agent: it adds the MCP server and starts the bridge with itself. */
export function setupPrompt(locale: "en" | "es", agent: SetupAgent, { appUrl, endpoint, token }: PromptInput): string {
  if (!isCli(agent)) return "";
  const t = PROMPT_TEXT[locale];
  const steps: string[] = [];
  if (agent === "claude") steps.push(`${t.addClaude}\n${indent(mcpSnippet("claude", endpoint, token).code)}`);
  else {
    const s = mcpSnippet(agent, endpoint, token);
    steps.push(t.saveEnv(token), `${t.addConfig(s.file)}\n${indent(s.code)}`);
  }
  steps.push(t.check(LIST_CMD[agent]));
  const b = bridgeCommands(agent, appUrl, token);
  steps.push(`${t.bridge}\n   - macOS / Linux:\n${indent(indent(b.unix))}\n   - Windows (PowerShell):\n${indent(indent(b.windows))}\n   ${t.bridgeCheck}`);
  steps.push(t.done(LABEL[agent]));
  return `${t.intro(LABEL[agent], appUrl)}\n\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;
}

const en = {
  title: "Integrations",
  back: "Back",
  intro:
    "Connect your own AI agent (Claude Code, Codex, OpenCode, Gemini CLI, Cursor, VS Code or any MCP client, or just an API key) so it can help with your mail, calendar, files, chat and meetings.",
  agentTitle: "Your AI agent",
  // Status card
  statusConnected: "Connected",
  statusIdle: "Token valid · no recent activity",
  statusTokenNoBridge: "Token valid · the bridge isn't running on your computer",
  statusOff: "Not connected",
  statusConnectedHint: "Your agent can use your workspace whenever you ask it.",
  statusIdleHint:
    "Your agent has access, but nothing has used it in the last few minutes. Meetings, chat and the dashboard also need the bridge running on your computer.",
  statusTokenNoBridgeHint: (ago: string) => `Requests from meetings, chat and the dashboard won't run until you start it. Last seen ${ago}.`,
  startBridgeTitle: "Start the bridge on your computer",
  startBridgeHint: "Replace <token> with your access token. If you no longer have it, connect again to get a new one.",
  statusOffHint: "Connect an agent so it can read your mail, check your calendar, find files and get things done for you.",
  mcpLabel: "Access (token / MCP)",
  bridgeLabel: "Bridge on your computer (meetings, chat, dashboard)",
  mcpActive: (name: string, ago: string) => `Active via “${name}” · ${ago}`,
  mcpLast: (ago: string) => `Last activity ${ago}`,
  mcpNever: "Not used yet",
  mcpNone: "Not set up",
  bridgeActive: (host: string | null, agent: string | null) =>
    agent ? (host ? `${agent} on ${host}` : `${agent} running`) : host ? `Bridge running on ${host}` : "Bridge running",
  bridgeLast: (ago: string) => `Bridge last seen ${ago}`,
  bridgeNever: "Bridge not running",
  needsAttention: "A connection needs to be reconnected — see below.",
  // Agent picker
  pickAgent: "Which agent do you use?",
  pickAgentHint: "Pick your agent to see the steps.",
  tabs: {
    claude: "Claude Code",
    codex: "Codex",
    opencode: "OpenCode",
    gemini: "Gemini CLI",
    mcp: "Cursor / VS Code / any MCP client",
    api: "API key (no CLI)",
  } as Record<string, string>,
  tabHints: {
    claude: "Anthropic's coding agent in your terminal.",
    codex: "OpenAI's coding agent in your terminal (codex).",
    opencode: "The open-source terminal agent, with any model provider.",
    gemini: "Google's agent in your terminal (gemini).",
    mcp: "Use the workspace tools from your editor or any app that speaks MCP. Meetings, chat and the dashboard need one of the other options (they run through the bridge).",
    api: "No agent to install: the bridge talks to an OpenAI-compatible API (OpenAI, OpenRouter, Groq, or a local Ollama / LM Studio) or to Anthropic's API, with your own key.",
  } as Record<string, string>,
  // Connect
  connect: "Connect",
  connectAnother: "Connect another",
  connecting: "Connecting…",
  expiryLabel: "Access expires",
  never: "Never",
  days: (n: number) => `In ${n} days`,
  year: "In 1 year",
  autoName: (agent: string, date: string) => `${agent} – ${date}`,
  stepTitle: (agent: string) => `Paste this into ${agent}`,
  stepHint: (agent: string) => `${agent} sets everything up on its own and tells you when it's ready.`,
  stepTitleMcp: "Add this to your app",
  stepHintMcp: "Pick the snippet for your app. The token is shown only now.",
  stepTitleApi: "Run the bridge with your API key",
  stepHintApi:
    "Needs Node 18+. Set your provider's key in the environment variable named by --api-key-env (it never leaves your computer except to that provider). For Ollama use --base-url http://localhost:11434/v1 and no key.",
  copyPrompt: "Copy prompt",
  copyToken: "Copy token only",
  copied: "Copied",
  copy: "Copy",
  tokenOnce: "This contains your access key and is shown only now. If you lose it, just connect again.",
  waiting: "Waiting for the agent to connect…",
  joined: "The agent is connected.",
  waitingBridge: "Waiting for the bridge to start…",
  bridgeUp: (host: string | null) => (host ? `Bridge running on ${host}.` : "Bridge running."),
  done: "Done",
  prompt: (agent: SetupAgent, input: PromptInput) => setupPrompt("en", agent, input),
  // Manual setup
  manualTitle: "Manual setup",
  manualHint: "If you'd rather do it by hand. Replace <token> with your token.",
  manualClaudeCode: "Claude Code (terminal)",
  manualDesktop: "Claude Desktop",
  manualDesktopHint: "Add to claude_desktop_config.json and restart Claude Desktop (needs Node.js).",
  manualGeneric: "Any other MCP client",
  manualGenericHint: "Standard MCP Streamable HTTP server with a static Bearer token:",
  manualEnv: "Keep the token in the ZENTICO_MCP_TOKEN environment variable (the configs below read it from there):",
  manualBridge: "Bridge (meetings, chat and dashboard)",
  manualBridgeHint: "Download it and keep it running (Node 18+). --agent picks the agent; --dry-run shows what it would run.",
  manualClaudeAi:
    "claude.ai and ChatGPT connectors sign in with OAuth, which isn't available yet: use a CLI, an editor or the API-key bridge instead.",
  tokenPlaceholder: "<token>",
  // Assistant name
  nameTitle: "Assistant name",
  nameHint:
    "What you call your assistant in meetings (“Jarvis, …”) and how it's shown everywhere. Leave it empty to use “Assistant”, which always works too, as does your agent's own name.",
  nameLabel: "Name",
  wakeLabel: "Other wake words",
  wakeHint: "Separated by commas, up to 6 (letters and spaces).",
  save: "Save",
  saved: "Saved",
  nameInvalid: "Use 1–24 letters and spaces.",
  wakeInvalid: "Use up to 6 words or names, letters and spaces only.",
  // Connections (tokens)
  tokensTitle: "Connections",
  tokensHint: "Each connection is an access key that acts as you. Revoke it and that app loses access right away.",
  noTokens: "Nothing connected yet.",
  scopeWrite: "Can read and act",
  scopeRead: "Can only read",
  lastActivity: "Last activity",
  neverUsed: "never",
  expires: "Expires",
  neverExpires: "Never expires",
  expired: "Expired",
  reauth: "Lost its access to your mail account. Reconnect it — the apps using it don't need to change anything.",
  legacy: "Uses an older kind of access that no longer works. Reconnect it — the apps using it don't need to change anything.",
  reconnect: "Reconnect",
  revoke: "Revoke",
  revokeConfirm: (name: string) => `Revoke “${name}”? Apps using it will lose access.`,
  // Capabilities
  capsTitle: "What your agent can do",
  capsIntro:
    "Your agent acts as you and only sees what you can already see. Items marked “changes” need a connection that can read and act; anything that sends, posts, shares or deletes is confirmed with you first.",
  changesBadge: "changes",
  bridgeCapsTitle: "From meetings, chat and the dashboard",
  bridgeCaps:
    "With the bridge running, hold C in a Zentico Meet call (or type in “Ask my …”), mention your assistant in Chat, or ask from your dashboard — your own agent does it on your computer. Your requests only reach your own bridge, and anything that sends or changes something waits for your OK.",
  groups: {
    account: "Account",
    mail: "Mail",
    calendar: "Calendar",
    contacts: "Contacts",
    drive: "Drive & Docs",
    chat: "Chat",
    meetings: "Meetings",
  } as Record<string, string>,
  tools: {
    whoami: "See your name, email and this token's permissions.",
    mail_search: "Search your mail and list matching conversations.",
    mail_get_thread: "Read a mail conversation, including attachment names.",
    mail_send: "Send an email from your account.",
    mail_create_draft: "Save an email draft for you to review.",
    mail_move: "Move emails to another folder (archive, trash…).",
    mail_set_keywords: "Mark emails read/unread, star them, add or remove labels.",
    mail_reply: "Reply or reply to all, quoting the original (saved as a draft unless sending is asked).",
    mail_forward: "Forward an email with its attachments (saved as a draft unless sending is asked).",
    mail_mark_read: "Mark emails as read or unread.",
    mail_list_labels: "List your mail labels.",
    mail_label: "Apply or remove a label on emails, or create a label.",
    mail_list_folders: "List your mail folders with unread counts.",
    mail_create_folder: "Create a mail folder.",
    mail_delete: "Move emails to Trash (deleting forever needs explicit confirmation).",
    mail_filters_list: "List your mail filter rules.",
    mail_filters_add: "Add a mail filter rule (move, label, mark read, forward…).",
    mail_get_attachment_text: "Read the text of an email attachment (text files and office documents).",
    calendar_list_events: "List events in your own and shared calendars.",
    calendar_create_event: "Create an event and email invitations to attendees.",
    calendar_find_free_time: "Find times when you and colleagues are free (free/busy only).",
    calendar_list_calendars: "List your calendars and the ones shared with you.",
    calendar_get_event: "Read an event in full: agenda, attendees and their answers.",
    calendar_update_event: "Change an event you organize (attendees are notified).",
    calendar_delete_event: "Delete an event (attendees get a cancellation if you organize it).",
    calendar_rsvp: "Accept, decline or tentatively answer an invitation.",
    contacts_search: "Search your contacts and the colleague directory.",
    directory_search: "Search the colleague directory (one entry per person, readable names).",
    contacts_create: "Add a contact to your address book.",
    contacts_update: "Update a contact's details.",
    contacts_delete: "Delete a contact.",
    drive_list: "List the files in a Drive folder.",
    drive_search: "Find Drive files and folders by name.",
    drive_read_text: "Read Drive files as text (text, Markdown, CSV, office documents…).",
    drive_write_text: "Create or overwrite a text file in Drive.",
    docs_create_markdown: "Create a Markdown document.",
    drive_get_info: "See a file's details: location, your rights and who it's shared with.",
    drive_edit_text: "Edit part of a text or Markdown file without overwriting others' changes.",
    drive_upload: "Upload a file to Drive (up to 10 MB).",
    drive_create_folder: "Create a Drive folder.",
    drive_rename: "Rename a file or folder.",
    drive_move: "Move files or folders to another folder.",
    drive_copy: "Make a copy of a file.",
    drive_delete: "Move files or folders to the trash (only after you confirm).",
    drive_share: "Share a file or folder with colleagues or groups, or remove their access.",
    drive_list_shared_with_me: "List files and spaces others share with you.",
    docs_list: "List your documents, spreadsheets, presentations, Markdown docs and whiteboards.",
    docs_create: "Create a document, spreadsheet, presentation, Markdown doc or whiteboard.",
    whiteboard_read: "Read the shapes and text on a whiteboard.",
    whiteboard_add_elements: "Add shapes, text and arrows to a whiteboard.",
    chat_list_conversations: "List your chats, groups and channels.",
    chat_read_messages: "Read messages in a chat you belong to.",
    chat_post_message: "Post a message as you in a chat.",
    chat_create_conversation: "Start a direct message or a group chat with colleagues.",
    chat_list_teams: "List your teams and their channels.",
    chat_react: "React to a chat message with an emoji.",
    chat_share_drive_file: "Share Drive files in a chat, granting access only if you choose to.",
    meetings_list: "List meetings you took part in that were recorded.",
    meetings_get_transcript: "Read the transcript of one of those meetings.",
    meet_create_room: "Create a video meeting room and get its link.",
    meetings_get_summary_inputs: "Gather a meeting's transcript, participants, chat and event to summarize it.",
    meeting_current: "See the call you are in: who is there and what is on its live stage.",
    meeting_list_participants: "List who is in the call right now.",
    meeting_get_live_context: "Read what was said recently in the call (only while you have listening on).",
    meeting_stage_open: "Open the call's shared stage with a whiteboard everyone sees live.",
    meeting_whiteboard_create: "Add another whiteboard to the call's stage.",
    meeting_whiteboard_read: "Read what is drawn on a whiteboard in the call.",
    meeting_whiteboard_add: "Draw on the call's shared whiteboard; everyone in the call sees it live.",
    meeting_whiteboard_update: "Change text, position or colors of shapes on the call's whiteboard.",
    meeting_whiteboard_remove: "Remove shapes from the call's whiteboard.",
    meeting_pin_card: "Pin notes, decisions, action items, an agenda or a table for everyone in the call.",
    meeting_update_card: "Add to or change a card pinned in the call.",
    meeting_unpin: "Remove a card or whiteboard from the call's stage.",
    meeting_stage_focus: "Bring a card or whiteboard to the front for everyone in the call.",
    meeting_stage_save: "Save the call's whiteboards and cards to your Drive and share them with the people in it.",
  } as Record<string, string>,
  neverTitle: "Never has access to",
  neverList: [
    "Other people's private mail, calendars, files or chats — only what you can already see yourself.",
    "Your password or sign-in: access can be revoked at any time and never reveals your credentials.",
    "Admin settings: users, domains, passwords, quotas.",
    "Your other connections, or creating new ones.",
  ],
  // Activity
  activityTitle: "Recent activity",
  noActivity: "Nothing yet.",
  ok: "OK",
  failed: "Failed",
  errors: {
    invalid_name: "Something went wrong naming the connection. Try again.",
    invalid_expiry: "Choose a valid expiry.",
    too_many: "You have too many connections. Revoke one first.",
    authorize: "The mail server needs your authorization first. Try again.",
    authorize_failed: "The mail server authorization didn't complete. Try again.",
    not_allowed:
      "The mail server doesn't allow creating access keys for this app. Ask your administrator to allow the Security scope for the workspace's OAuth client.",
    key_quota:
      "Your mail account has reached its limit of access keys. Revoke a connection (or delete an unused API key in your mail account settings) first.",
    failed: "Something went wrong. Try again.",
  },
};

export type Copy = typeof en;

const es: Copy = {
  title: "Integraciones",
  back: "Volver",
  intro:
    "Conecta tu propio agente de IA (Claude Code, Codex, OpenCode, Gemini CLI, Cursor, VS Code o cualquier cliente MCP, o simplemente una clave de API) para que te ayude con tu correo, calendario, archivos, chat y reuniones.",
  agentTitle: "Tu agente de IA",
  statusConnected: "Conectado",
  statusIdle: "Token válido · sin actividad reciente",
  statusTokenNoBridge: "Token válido · el puente no está activo en tu ordenador",
  statusOff: "No conectado",
  statusConnectedHint: "Tu agente puede usar tu espacio de trabajo cuando se lo pidas.",
  statusIdleHint:
    "Tu agente tiene acceso, pero nada lo ha usado en los últimos minutos. Reuniones, chat y dashboard necesitan además el puente activo en tu ordenador.",
  statusTokenNoBridgeHint: (ago: string) => `Las peticiones de reuniones, chat y dashboard no se ejecutarán hasta que lo arranques. Visto por última vez ${ago}.`,
  startBridgeTitle: "Arranca el puente en tu ordenador",
  startBridgeHint: "Sustituye <token> por tu token de acceso. Si ya no lo tienes, vuelve a conectar para obtener uno nuevo.",
  statusOffHint: "Conecta un agente para que pueda leer tu correo, mirar tu calendario, encontrar archivos y hacer cosas por ti.",
  mcpLabel: "Acceso (token / MCP)",
  bridgeLabel: "Puente en tu ordenador (reuniones, chat, dashboard)",
  mcpActive: (name: string, ago: string) => `Activo con «${name}» · ${ago}`,
  mcpLast: (ago: string) => `Última actividad ${ago}`,
  mcpNever: "Aún sin usar",
  mcpNone: "Sin configurar",
  bridgeActive: (host: string | null, agent: string | null) =>
    agent ? (host ? `${agent} en ${host}` : `${agent} en marcha`) : host ? `Puente activo en ${host}` : "Puente activo",
  bridgeLast: (ago: string) => `Puente visto por última vez ${ago}`,
  bridgeNever: "Puente sin iniciar",
  needsAttention: "Hay una conexión que necesita reconectarse: mira más abajo.",
  pickAgent: "¿Qué agente usas?",
  pickAgentHint: "Elige tu agente para ver los pasos.",
  tabs: {
    claude: "Claude Code",
    codex: "Codex",
    opencode: "OpenCode",
    gemini: "Gemini CLI",
    mcp: "Cursor / VS Code / cualquier cliente MCP",
    api: "Clave de API (sin CLI)",
  },
  tabHints: {
    claude: "El agente de programación de Anthropic en tu terminal.",
    codex: "El agente de programación de OpenAI en tu terminal (codex).",
    opencode: "El agente de terminal de código abierto, con cualquier proveedor de modelos.",
    gemini: "El agente de Google en tu terminal (gemini).",
    mcp: "Usa las herramientas del espacio de trabajo desde tu editor o cualquier app que hable MCP. Reuniones, chat y dashboard necesitan una de las otras opciones (pasan por el puente).",
    api: "Sin nada que instalar: el puente habla con una API compatible con OpenAI (OpenAI, OpenRouter, Groq, o Ollama / LM Studio en local) o con la API de Anthropic, con tu propia clave.",
  },
  connect: "Conectar",
  connectAnother: "Conectar otro",
  connecting: "Conectando…",
  expiryLabel: "El acceso caduca",
  never: "Nunca",
  days: (n: number) => `En ${n} días`,
  year: "En 1 año",
  autoName: (agent: string, date: string) => `${agent} – ${date}`,
  stepTitle: (agent: string) => `Pega esto en ${agent}`,
  stepHint: (agent: string) => `${agent} lo configura todo por su cuenta y te avisa cuando esté listo.`,
  stepTitleMcp: "Añade esto a tu app",
  stepHintMcp: "Elige el fragmento de tu app. El token solo se muestra ahora.",
  stepTitleApi: "Arranca el puente con tu clave de API",
  stepHintApi:
    "Necesita Node 18+. Pon la clave de tu proveedor en la variable de entorno que indica --api-key-env (solo sale de tu ordenador hacia ese proveedor). Para Ollama usa --base-url http://localhost:11434/v1 y sin clave.",
  copyPrompt: "Copiar prompt",
  copyToken: "Copiar solo el token",
  copied: "Copiado",
  copy: "Copiar",
  tokenOnce: "Esto incluye tu clave de acceso y solo se muestra ahora. Si lo pierdes, vuelve a conectar.",
  waiting: "Esperando a que el agente se conecte…",
  joined: "El agente se ha conectado.",
  waitingBridge: "Esperando a que arranque el puente…",
  bridgeUp: (host: string | null) => (host ? `Puente activo en ${host}.` : "Puente activo."),
  done: "Hecho",
  prompt: (agent: SetupAgent, input: PromptInput) => setupPrompt("es", agent, input),
  manualTitle: "Configuración manual",
  manualHint: "Si prefieres hacerlo a mano. Sustituye <token> por tu token.",
  manualClaudeCode: "Claude Code (terminal)",
  manualDesktop: "Claude Desktop",
  manualDesktopHint: "Añádelo a claude_desktop_config.json y reinicia Claude Desktop (necesita Node.js).",
  manualGeneric: "Cualquier otro cliente MCP",
  manualGenericHint: "Servidor MCP Streamable HTTP estándar con un token Bearer fijo:",
  manualEnv: "Guarda el token en la variable de entorno ZENTICO_MCP_TOKEN (las configuraciones de abajo lo leen de ahí):",
  manualBridge: "Puente (reuniones, chat y dashboard)",
  manualBridgeHint: "Descárgalo y déjalo corriendo (Node 18+). --agent elige el agente; --dry-run muestra lo que ejecutaría.",
  manualClaudeAi:
    "Los conectores de claude.ai y ChatGPT inician sesión con OAuth, que aún no está disponible: usa una CLI, un editor o el puente con clave de API.",
  tokenPlaceholder: "<token>",
  nameTitle: "Nombre del asistente",
  nameHint:
    "Cómo llamas a tu asistente en las reuniones («Jarvis, …») y cómo se muestra en todas partes. Déjalo vacío para usar «Asistente», que también funciona siempre, igual que el nombre de tu agente.",
  nameLabel: "Nombre",
  wakeLabel: "Otras palabras de activación",
  wakeHint: "Separadas por comas, hasta 6 (letras y espacios).",
  save: "Guardar",
  saved: "Guardado",
  nameInvalid: "Usa de 1 a 24 letras y espacios.",
  wakeInvalid: "Usa hasta 6 palabras o nombres, solo letras y espacios.",
  tokensTitle: "Conexiones",
  tokensHint: "Cada conexión es una clave de acceso que actúa como tú. Si la revocas, esa aplicación pierde el acceso al momento.",
  noTokens: "Aún no hay nada conectado.",
  scopeWrite: "Puede leer y actuar",
  scopeRead: "Solo puede leer",
  lastActivity: "Última actividad",
  neverUsed: "nunca",
  expires: "Caduca",
  neverExpires: "No caduca",
  expired: "Caducada",
  reauth: "Ha perdido el acceso a tu cuenta de correo. Reconéctala: las aplicaciones que la usan no tienen que cambiar nada.",
  legacy: "Usa un tipo de acceso antiguo que ya no funciona. Reconéctala: las aplicaciones que la usan no tienen que cambiar nada.",
  reconnect: "Reconectar",
  revoke: "Revocar",
  revokeConfirm: (name: string) => `¿Revocar «${name}»? Las aplicaciones que la usan perderán el acceso.`,
  capsTitle: "Qué puede hacer tu agente",
  capsIntro:
    "Tu agente actúa como tú y solo ve lo que tú ya puedes ver. Lo marcado con «cambia» necesita una conexión que pueda leer y actuar; todo lo que envía, publica, comparte o borra te lo confirma antes.",
  changesBadge: "cambia",
  bridgeCapsTitle: "Desde reuniones, chat y dashboard",
  bridgeCaps:
    "Con el puente en marcha, mantén pulsada la C en una llamada de Zentico Meet (o escribe en «Pregunta a mi …»), menciona a tu asistente en el chat o pídeselo desde tu dashboard: tu propio agente lo hace en tu ordenador. Tus peticiones solo llegan a tu puente, y todo lo que envía o cambia algo espera a que des el visto bueno.",
  groups: {
    account: "Cuenta",
    mail: "Correo",
    calendar: "Calendario",
    contacts: "Contactos",
    drive: "Drive y Docs",
    chat: "Chat",
    meetings: "Reuniones",
  },
  tools: {
    whoami: "Ver tu nombre, tu correo y los permisos de este token.",
    mail_search: "Buscar en tu correo y listar las conversaciones encontradas.",
    mail_get_thread: "Leer una conversación de correo, con los nombres de los adjuntos.",
    mail_send: "Enviar un correo desde tu cuenta.",
    mail_create_draft: "Guardar un borrador de correo para que lo revises.",
    mail_move: "Mover correos a otra carpeta (archivo, papelera…).",
    mail_set_keywords: "Marcar correos como leídos/no leídos, destacarlos, poner o quitar etiquetas.",
    mail_reply: "Responder o responder a todos citando el original (se guarda como borrador salvo que pidas enviarlo).",
    mail_forward: "Reenviar un correo con sus adjuntos (se guarda como borrador salvo que pidas enviarlo).",
    mail_mark_read: "Marcar correos como leídos o no leídos.",
    mail_list_labels: "Listar tus etiquetas de correo.",
    mail_label: "Poner o quitar una etiqueta en correos, o crear una etiqueta.",
    mail_list_folders: "Listar tus carpetas de correo con los no leídos.",
    mail_create_folder: "Crear una carpeta de correo.",
    mail_delete: "Mover correos a la papelera (borrarlos para siempre requiere confirmación explícita).",
    mail_filters_list: "Listar tus reglas de filtrado de correo.",
    mail_filters_add: "Añadir una regla de filtrado (mover, etiquetar, marcar como leído, reenviar…).",
    mail_get_attachment_text: "Leer el texto de un adjunto (archivos de texto y documentos de oficina).",
    calendar_list_events: "Listar eventos de tus calendarios y de los compartidos contigo.",
    calendar_create_event: "Crear un evento y enviar invitaciones por correo.",
    calendar_find_free_time: "Encontrar huecos libres tuyos y de tus compañeros (solo libre/ocupado).",
    calendar_list_calendars: "Listar tus calendarios y los compartidos contigo.",
    calendar_get_event: "Leer un evento completo: agenda, invitados y sus respuestas.",
    calendar_update_event: "Cambiar un evento que organizas (se avisa a los invitados).",
    calendar_delete_event: "Eliminar un evento (si lo organizas, los invitados reciben la cancelación).",
    calendar_rsvp: "Aceptar, rechazar o responder «quizás» a una invitación.",
    contacts_search: "Buscar en tus contactos y en el directorio de compañeros.",
    directory_search: "Buscar en el directorio de compañeros (una entrada por persona, con nombres legibles).",
    contacts_create: "Añadir un contacto a tu libreta.",
    contacts_update: "Actualizar los datos de un contacto.",
    contacts_delete: "Eliminar un contacto.",
    drive_list: "Listar los archivos de una carpeta de Drive.",
    drive_search: "Buscar archivos y carpetas de Drive por nombre.",
    drive_read_text: "Leer archivos de Drive como texto (texto, Markdown, CSV, documentos de oficina…).",
    drive_write_text: "Crear o sobrescribir un archivo de texto en Drive.",
    docs_create_markdown: "Crear un documento Markdown.",
    drive_get_info: "Ver los detalles de un archivo: ubicación, tus permisos y con quién se comparte.",
    drive_edit_text: "Editar parte de un archivo de texto o Markdown sin pisar cambios de otros.",
    drive_upload: "Subir un archivo a Drive (hasta 10 MB).",
    drive_create_folder: "Crear una carpeta en Drive.",
    drive_rename: "Cambiar el nombre de un archivo o carpeta.",
    drive_move: "Mover archivos o carpetas a otra carpeta.",
    drive_copy: "Hacer una copia de un archivo.",
    drive_delete: "Mover archivos o carpetas a la papelera (solo tras tu confirmación).",
    drive_share: "Compartir un archivo o carpeta con compañeros o grupos, o quitarles el acceso.",
    drive_list_shared_with_me: "Listar archivos y espacios que otros comparten contigo.",
    docs_list: "Listar tus documentos, hojas de cálculo, presentaciones, documentos Markdown y pizarras.",
    docs_create: "Crear un documento, hoja de cálculo, presentación, documento Markdown o pizarra.",
    whiteboard_read: "Leer las formas y textos de una pizarra.",
    whiteboard_add_elements: "Añadir formas, textos y flechas a una pizarra.",
    chat_list_conversations: "Listar tus chats, grupos y canales.",
    chat_read_messages: "Leer mensajes de un chat del que formas parte.",
    chat_post_message: "Publicar un mensaje en tu nombre en un chat.",
    chat_create_conversation: "Iniciar un mensaje directo o un chat de grupo con compañeros.",
    chat_list_teams: "Listar tus equipos y sus canales.",
    chat_react: "Reaccionar con un emoji a un mensaje del chat.",
    chat_share_drive_file: "Compartir archivos de Drive en un chat, dando acceso solo si tú lo decides.",
    meetings_list: "Listar las reuniones grabadas en las que participaste.",
    meetings_get_transcript: "Leer la transcripción de una de esas reuniones.",
    meet_create_room: "Crear una sala de videollamada y obtener su enlace.",
    meetings_get_summary_inputs: "Reunir transcripción, participantes, chat y evento de una reunión para resumirla.",
    meeting_current: "Ver la llamada en la que estás: quién está y qué hay en su escenario en vivo.",
    meeting_list_participants: "Listar quién está ahora en la llamada.",
    meeting_get_live_context: "Leer lo que se dijo hace poco en la llamada (solo con la escucha activada).",
    meeting_stage_open: "Abrir el escenario compartido de la llamada con una pizarra que todos ven en vivo.",
    meeting_whiteboard_create: "Añadir otra pizarra al escenario de la llamada.",
    meeting_whiteboard_read: "Leer lo que hay dibujado en una pizarra de la llamada.",
    meeting_whiteboard_add: "Dibujar en la pizarra compartida de la llamada; todos en la llamada lo ven en vivo.",
    meeting_whiteboard_update: "Cambiar el texto, la posición o los colores de las formas de la pizarra de la llamada.",
    meeting_whiteboard_remove: "Quitar formas de la pizarra de la llamada.",
    meeting_pin_card: "Fijar notas, decisiones, tareas, una agenda o una tabla para todos en la llamada.",
    meeting_update_card: "Añadir o cambiar algo en una tarjeta fijada en la llamada.",
    meeting_unpin: "Quitar una tarjeta o pizarra del escenario de la llamada.",
    meeting_stage_focus: "Poner una tarjeta o pizarra al frente para todos en la llamada.",
    meeting_stage_save: "Guardar las pizarras y tarjetas de la llamada en tu Drive y compartirlas con quienes estuvieron.",
  },
  neverTitle: "Nunca tiene acceso a",
  neverList: [
    "Correo, calendarios, archivos o chats privados de otras personas: solo lo que tú ya puedes ver.",
    "Tu contraseña o tu inicio de sesión: el acceso se puede revocar cuando quieras y nunca revela tus credenciales.",
    "Ajustes de administración: usuarios, dominios, contraseñas, cuotas.",
    "Tus otras conexiones, ni crear conexiones nuevas.",
  ],
  activityTitle: "Actividad reciente",
  noActivity: "Aún no hay nada.",
  ok: "OK",
  failed: "Error",
  errors: {
    invalid_name: "Algo falló al nombrar la conexión. Inténtalo de nuevo.",
    invalid_expiry: "Elige una caducidad válida.",
    too_many: "Tienes demasiadas conexiones. Revoca alguna primero.",
    authorize: "El servidor de correo necesita antes tu autorización. Inténtalo de nuevo.",
    authorize_failed: "La autorización del servidor de correo no se completó. Inténtalo de nuevo.",
    not_allowed:
      "El servidor de correo no permite crear claves de acceso para esta aplicación. Pide a tu administrador que permita el ámbito Security en el cliente OAuth del espacio de trabajo.",
    key_quota:
      "Tu cuenta de correo alcanzó su límite de claves de acceso. Revoca una conexión (o borra una clave API sin uso en los ajustes de tu cuenta de correo) primero.",
    failed: "Algo salió mal. Inténtalo de nuevo.",
  },
};

export const copyFor = (locale: string): Copy => (locale.startsWith("es") ? es : en);
