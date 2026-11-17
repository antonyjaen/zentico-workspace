# Setup prompt for an AI agent

Copy the prompt below into your AI coding agent (Claude Code, Codex, Gemini CLI… any agent that can run commands over SSH) on your own
computer. It sets up Zentico Workspace on a fresh Ubuntu 22.04/24.04 server with
[`install.sh`](install.sh). You stay in charge of DNS and of anything destructive.

---

```text
Goal: install Zentico Workspace (https://github.com/antonyjaen/zentico-workspace) on my fresh
Ubuntu 22.04/24.04 VPS using its deploy/install.sh script, and verify it works.

First ask me for, and wait for my answers:
1. The server's public IPv4 address and how to reach it over SSH (user, key file).
2. The base domain (e.g. example.com). The app will be team.<domain>; mail, meet and (optional)
   office subdomains are used too. Mail addresses will be @<domain>.
3. The admin e-mail (Let's Encrypt notices; if it is on <domain>, it also becomes the app admin).
4. Whether to enable Collabora Online for office documents (--office, needs ~2 GB more RAM) and a
   Whisper server for meeting transcripts (--whisper, CPU heavy).

Steps:
1. SSH in and check the basics: Ubuntu version, free RAM (4 GB+ recommended, 8 GB with both
   options), free disk (20 GB+), that ports 25/80/443 aren't already used by something else
   (`sudo ss -lntp`). Report anything unusual before continuing.
2. Clone the repository (git clone https://github.com/antonyjaen/zentico-workspace.git) into the
   user's home and run, from it:
     sudo ./deploy/install.sh --domain <domain> --email <email> --ip <ip> --yes --skip-dns-check [--office] [--whisper]
   (use --skip-dns-check only for this first run, so it doesn't block on DNS).
3. Show me the DNS records the script printed and ask me to create them at my DNS provider. Also
   remind me to set the reverse DNS (PTR) of the IP to mail.<domain> and to open the same ports in
   the provider's cloud firewall/security list if it has one (TCP 80, 443, 25, 465, 587, 993, 7881
   and UDP 7882).
4. When I say DNS is done, check it with `dig +short A team.<domain>` (and mail, meet, office),
   then re-run the same install.sh command without --skip-dns-check so it waits for HTTPS.
5. Walk me through the manual steps the script prints at the end (Stalwart admin: hostname, domain,
   DKIM record, TLS certificate path, user accounts; then the OAuth/OIDC client with ID
   zentico-workspace, redirect URI https://team.<domain>/api/auth/callback and the scopes listed).
   Tell me which command reveals each secret I need to paste (e.g. `sudo grep OIDC_CLIENT_SECRET
   deploy/workspace.env`) and let me run it myself.

Verify success and report each check as pass/fail:
- `cd deploy && sudo docker compose ps`: every service is running (none restarting).
- `curl -fsS https://team.<domain>/api/workspace-info` answers with JSON.
- `curl -fsS https://mail.<domain>/healthz/live` succeeds.
- `curl -fsSI https://meet.<domain>` answers (LiveKit).
- With --office: `curl -fsS https://office.<domain>/hosting/discovery | head -c 200` returns XML.
- I can sign in at https://team.<domain> with a Stalwart account and see the mail inbox.

Safety rules:
- Never print, echo, log or paste secret values (deploy/.env, deploy/workspace.env, livekit.yaml,
  egress.yaml, passwords, tokens) into this chat or any file outside the server. To check a variable
  exists, print only its name, e.g. `sudo sed 's/=.*/=<redacted>/' deploy/workspace.env`.
- Ask me before anything destructive or hard to undo: deleting files or volumes, `docker compose
  down -v`, `docker system prune`, changing firewall rules beyond the ports above, editing
  deploy/.env by hand, or rebooting.
- Don't edit the rendered config files unless something is broken; if you do, explain the change
  first. Re-running install.sh is safe and never overwrites existing secrets.
- If a step fails, show the relevant `docker compose logs <service> --tail 50` lines (with secrets
  redacted) and propose a fix instead of guessing.
```
