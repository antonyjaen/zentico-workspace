# Zentico Workspace — Plan

A private, self-hosted workspace (mail, calendar, contacts, drive, docs, meetings) with a
familiar Google-Workspace-style layout and a calm, privacy-first tone inspired by Proton —
in Zentico's own visual identity (no Google/Proton logos, colors, fonts or icons).

Lives at **team.zentico.dev**, linked from the zentico.dev header.

## Principles

- **Build the interface, not the servers.** Stalwart, Collabora and LiveKit stay unmodified
  and auto-update; this repo is only the product layer on top.
- **One login.** Sign in with the email address and email password (OIDC via Stalwart).
- **Private by default.** Tokens never reach the browser; remote images blocked; HTML mail
  sanitized and isolated; everything stays on Zentico infrastructure.
- **Familiar, not copied.** Launcher, search bar, app rail, floating sheet, keyboard shortcuts —
  with Zentico colors, Onest + IBM Plex Mono, and its own icon language.
- **Each module replaces its Nextcloud counterpart only when it's better.**

## Architecture

```
team.zentico.dev (Next.js · React · Tailwind v4 · next-intl)
 ├─ Login ─────────────── OIDC ──► Stalwart
 ├─ Mail/Calendar/Contacts/Files ─ JMAP ──► Stalwart   (push for live updates)
 ├─ Docs ──────────────── WOPI ──► Collabora
 ├─ Meet ─────────────────────────► LiveKit
 └─ Admin ─────── management API ──► Stalwart
```

- Server-side JMAP client (`src/lib/jmap.ts`) using the user's OAuth access token.
- Session: AES-GCM encrypted httpOnly cookie; middleware refreshes access tokens.
- Deployed as a container next to Stalwart on the Oracle server, behind Caddy.

## Phases

### 0. Foundation — done
- [x] Project scaffold (Next.js 15, React 19, Tailwind v4, TypeScript strict, ES/EN)
- [x] "Quiet Cobalt" design tokens, light + dark (system-aware, no flash)
- [x] OIDC sign-in with Stalwart (PKCE, encrypted session, token refresh, logout)
- [x] Workspace shell: app rail, search bar, app launcher, theme menu, account menu
- [x] Mail: folder list with unread counts, message list, pagination, full-text search
- [x] "Coming soon" pages for the remaining apps
- [x] Workspace link in the zentico.dev header
- [ ] Production deployment at team.zentico.dev

### 1. Mail
- Read view: thread conversation, sanitized HTML in a sandboxed frame, remote-image blocking
- Compose / reply / reply-all / forward, rich text, attachments (JMAP blob upload), drafts autosave
- Send-as identity per domain (zentico.dev, acme.example, globex.example, initech.example)
- Actions: archive, delete, spam, mark read/unread, star, move, labels; multi-select + bulk
- Live updates via JMAP push (EventSource)
- Keyboard shortcuts (c, r, a, f, e, #, j/k, /)
- Signatures, vacation responder, filters (Sieve) in settings
- Density and reading-pane options

### 2. Calendar & Contacts
- Day / week / month / agenda views, drag to create and move
- Events with guests, invitations and RSVPs (iTIP/iMIP), reminders, time zones
- Multiple and shared calendars, availability view
- Contacts: list, groups, search, quick-compose, autocomplete in mail

### 3. Drive & Docs
- Files and folders (Stalwart file storage), upload with progress, previews
- Sharing with people and links, permissions
- Documents, spreadsheets and presentations edited in the browser via Collabora (WOPI host)
- "New document" from the launcher and from Drive

### 4. Meet
- Self-hosted LiveKit server; meeting rooms with shareable links
- Camera, mic, screen share, grid/speaker layouts, chat
- "Join meeting" from calendar events; auto-generated links on new events

### 5. Admin & polish
- Users, domains, passwords and quotas via Stalwart's management API
- Onboarding flow, empty states, accessibility audit (WCAG AA), performance budget
- Mobile-responsive layouts (native mail/calendar apps keep working via IMAP/CalDAV)
- Retire Nextcloud modules that the workspace has replaced; backups to object storage

## Open decisions

- Product scope: internal for the team, or a multi-tenant Zentico product later
- Whether to keep Nextcloud Talk or move fully to LiveKit
- Shared inboxes (soporte@, facturas@): delegated access vs. group mailboxes
