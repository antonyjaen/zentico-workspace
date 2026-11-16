# Native apps

Thin native shells around a Zentico Workspace server. Nothing from the web app is bundled except
`launcher/index.html`, the first-run setup / offline page shared by both apps. The server address is
chosen on first launch and validated against `GET /api/workspace-info` (public, served by this repo's
web app — deploy it before shipping the apps). `zentico://open?server=team.example.com` prefills setup;
`zentico://<path>` opens that path on the saved workspace.

## Desktop (`desktop/`, Tauri v2)

- `npm install`, then `npm run dev` (debug window) or `npm run build` (NSIS `.exe` + MSI in
  `src-tauri/target/release/bundle/`). Needs Rust and, on Windows, WebView2 (the installer bootstraps it).
- Change the server later from the tray menu: **Change workspace…** (or the Retry screen when offline).
- Security: the remote site only gets the `notify` command, granted at startup to the saved origin
  only (runtime capability in `src-tauri/src/lib.rs`); changing the workspace restarts the app.
- Windows signing: unsigned installers trigger SmartScreen. Set `bundle.windows.certificateThumbprint`
  (or `signCommand` for a cloud HSM / Azure Trusted Signing) in `tauri.conf.json` and build on a machine
  with the certificate. macOS needs a Developer ID + notarization (`APPLE_*` env vars), built on a Mac.
- Microsoft Defender ASR rule "block executables unless they meet prevalence/age criteria" blocks
  Cargo build scripts. Exclude the target dir (admin):
  `Add-MpPreference -AttackSurfaceReductionOnlyExclusions "<repo>\apps\desktop\src-tauri\target"`
  or build with `CARGO_TARGET_DIR` pointing to an already excluded folder.
