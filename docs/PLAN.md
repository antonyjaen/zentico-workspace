# Zentico Workspace — Plan

A private, self-hosted workspace (mail, calendar, contacts, drive, docs, meetings) with a
familiar Google-Workspace-style layout, a privacy-first tone inspired by Proton, and a
Vercel-style visual system (monochrome, Geist, 1px hairlines, tight radii) — in Zentico's own
identity (no Google/Proton/Vercel logos or trade dress).

Lives at **team.zentico.dev**, linked from the zentico.dev header.

## Principles

- **Build the interface, not the servers.** Stalwart, Collabora and LiveKit stay unmodified
  and auto-update; this repo is only the product layer on top.
- **One login.** Sign in with the email address and email password (OIDC via Stalwart).
- **Private by default.** Tokens never reach the browser; remote images blocked; HTML mail
  sanitized and isolated; everything stays on Zentico infrastructure.
- **Familiar, not copied.** Launcher, search bar, app rail, keyboard shortcuts — in a
  monochrome "Monochrome Grid" system: Geist + Geist Mono, hairline borders instead of shadows,
  solid-ink primary actions, Zentico cobalt only for focus/links, gradient avatars, dark mode first.
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
- [x] Vercel-style design tokens (Geist, monochrome, hairlines), light + dark (system-aware, no flash)
- [x] "/" to focus search
- [x] OIDC sign-in with Stalwart (PKCE, encrypted session, token refresh, logout)
- [x] Workspace shell: app rail, search bar, app launcher, theme menu, account menu
- [x] Mail: folder list with unread counts, message list, pagination, full-text search
- [x] "Coming soon" pages for the remaining apps
- [x] Workspace link in the zentico.dev header
- [ ] Production deployment at team.zentico.dev

### 1. Mail — built, verified live against Stalwart (2026-11-15)
- [x] Read view: thread conversation, sanitized HTML in a sandboxed frame, remote-image blocking
- [x] Compose / reply / reply-all / forward, rich text, attachments (JMAP blob upload), drafts autosave
- [x] Send-as identity per domain (identities come from Stalwart)
- [x] Actions: archive, delete, spam, mark read/unread, star, move; multi-select + bulk (labels: later)
- [x] Live updates via JMAP push (EventSource, proxied server-side)
- [x] Keyboard shortcuts (c, r, a, f, e, #, j/k, x, s, ?, /)
- [x] Signatures, vacation responder, filters (Sieve) in settings
- [x] Density option (reading pane: preference saved, layout not built yet)

### 2. Calendar & Contacts — built, core flows verified live (2026-11-15)
- [x] Day / week / month / agenda views, drag to create and move
- [x] Events with guests, invitations and RSVPs (iTIP/iMIP), reminders, time zones (invites not yet tested live)
- [ ] Shared calendars, availability view
- [x] Contacts: list, groups, search, quick-compose, autocomplete in mail

### 3. Drive & Docs — Drive verified live; Docs built, waiting for a Collabora server (2026-11-15)
- [x] Files and folders (Stalwart JMAP FileNode), upload with progress, previews
- [ ] Sharing with people and links, permissions
- [x] Documents, spreadsheets and presentations via Collabora (WOPI host) — needs COLLABORA_URL + Collabora aliasgroup
- [x] "New document" from Docs and from Drive

### 4. Meet — built, waiting for a LiveKit server (2026-11-15)
- [ ] Self-hosted LiveKit server (LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET); [x] rooms with shareable links
- [x] Camera, mic, screen share, grid/speaker layouts, chat
- [x] "Join meeting" from calendar events; [x] opt-in "Add video meeting" on events
- [ ] Guest access for people without a Zentico account

### 5. Admin & polish
- Users, domains, passwords and quotas via Stalwart's management API
- Onboarding flow, empty states, accessibility audit (WCAG AA), performance budget
- Mobile-responsive layouts (native mail/calendar apps keep working via IMAP/CalDAV)
- Retire Nextcloud modules that the workspace has replaced; backups to object storage

## Open decisions

- Product scope: internal for the team, or a multi-tenant Zentico product later
- Whether to keep Nextcloud Talk or move fully to LiveKit
- Shared inboxes (soporte@, facturas@): delegated access vs. group mailboxes
