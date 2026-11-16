// Registry of the third-party services people can connect (OAuth 2.0 authorization code flow).
// Client credentials are provided by the admin per provider in env vars
// (CONNECT_<PROVIDER>_CLIENT_ID / CONNECT_<PROVIDER>_CLIENT_SECRET); providers without them are
// listed as "not configured". Scopes are the minimum the tools in lib/mcp/connect-tools.ts need.
// Server-only (reads the environment).
import { env } from "../env";

export const PROVIDER_IDS = ["github", "google", "atlassian", "notion", "slack"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export const isProviderId = (v: unknown): v is ProviderId => typeof v === "string" && (PROVIDER_IDS as readonly string[]).includes(v);

export type Provider = {
  id: ProviderId;
  name: string;
  envPrefix: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** Requested scopes (shown on the card). */
  scopes: string[];
  /** Authorize parameter carrying the scopes (Slack user tokens use user_scope). */
  scopeParam: "scope" | "user_scope";
  scopeSeparator: " " | ",";
  /** Sends a PKCE S256 challenge (RFC 7636). */
  pkce: boolean;
  /** How the client authenticates at the token endpoint and how the body is encoded. */
  tokenAuth: "body" | "basic";
  tokenFormat: "form" | "json";
  extraAuthorize?: Record<string, string>;
  /** Hosts the server may call for this provider (token, userinfo, API, revoke). */
  hosts: readonly string[];
  /** Disconnect also revokes the grant at the provider. */
  revocable: boolean;
  /** Where people manage the grant themselves at the provider (shown when it can't be revoked). */
  manageUrl?: string;
};

const PROVIDERS: Record<ProviderId, Provider> = {
  github: {
    id: "github",
    name: "GitHub",
    envPrefix: "CONNECT_GITHUB",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    // OAuth apps have no narrower scope that covers private-repo issues and pull requests.
    scopes: ["repo"],
    scopeParam: "scope",
    scopeSeparator: " ",
    pkce: true,
    tokenAuth: "body",
    tokenFormat: "form",
    extraAuthorize: { allow_signup: "false" },
    hosts: ["github.com", "api.github.com"],
    revocable: true,
  },
  google: {
    id: "google",
    name: "Google",
    envPrefix: "CONNECT_GOOGLE",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/drive.readonly",
    ],
    scopeParam: "scope",
    scopeSeparator: " ",
    pkce: true,
    tokenAuth: "body",
    tokenFormat: "form",
    // A refresh token on every connect (Google only returns one with consent).
    extraAuthorize: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    hosts: ["oauth2.googleapis.com", "openidconnect.googleapis.com", "www.googleapis.com"],
    revocable: true,
  },
  atlassian: {
    id: "atlassian",
    name: "Jira",
    envPrefix: "CONNECT_ATLASSIAN",
    authorizeUrl: "https://auth.atlassian.com/authorize",
    tokenUrl: "https://auth.atlassian.com/oauth/token",
    scopes: ["read:jira-work", "write:jira-work", "read:jira-user", "read:me", "offline_access"],
    scopeParam: "scope",
    scopeSeparator: " ",
    pkce: false,
    tokenAuth: "body",
    tokenFormat: "json",
    extraAuthorize: { audience: "api.atlassian.com", prompt: "consent" },
    hosts: ["auth.atlassian.com", "api.atlassian.com"],
    // Atlassian 3LO has no revocation endpoint.
    revocable: false,
    manageUrl: "https://id.atlassian.com/manage-profile/apps",
  },
  notion: {
    id: "notion",
    name: "Notion",
    envPrefix: "CONNECT_NOTION",
    authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    // Notion has no OAuth scopes: capabilities are set on the integration, pages are picked by the user.
    scopes: [],
    scopeParam: "scope",
    scopeSeparator: " ",
    pkce: false,
    tokenAuth: "basic",
    tokenFormat: "json",
    extraAuthorize: { owner: "user" },
    hosts: ["api.notion.com"],
    revocable: true,
  },
  slack: {
    id: "slack",
    name: "Slack",
    envPrefix: "CONNECT_SLACK",
    authorizeUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    scopes: ["channels:read", "groups:read", "chat:write"],
    scopeParam: "user_scope",
    scopeSeparator: ",",
    pkce: false,
    tokenAuth: "body",
    tokenFormat: "form",
    hosts: ["slack.com"],
    revocable: true,
  },
};

export const provider = (id: ProviderId): Provider => PROVIDERS[id];
export const allProviders = (): Provider[] => PROVIDER_IDS.map((id) => PROVIDERS[id]);

export type ClientConfig = { clientId: string; clientSecret: string };

/** The admin-provided client credentials, or null when the provider isn't configured. */
export function clientConfig(id: ProviderId): ClientConfig | null {
  const p = PROVIDERS[id];
  const clientId = process.env[`${p.envPrefix}_CLIENT_ID`]?.trim();
  const clientSecret = process.env[`${p.envPrefix}_CLIENT_SECRET`]?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export const isConfigured = (id: ProviderId) => clientConfig(id) !== null;

/** The redirect URI to register at the provider. */
export const callbackUrl = (id: ProviderId) => `${env.appUrl}/api/connect/${id}/callback`;
