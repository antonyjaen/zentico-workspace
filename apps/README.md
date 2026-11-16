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

## Mobile (`mobile/`, Capacitor 8)

- `npm install`, then `npm run build` (debug APK in `android/app/build/outputs/apk/debug/`) or
  `npm run dev` (install + run on a device/emulator). `npm run assets` regenerates icons/splash from the logo.
- The launcher is the app's bundled web content; the saved server lives in native storage
  (SharedPreferences / UserDefaults). The `Workspace` plugin (`MainActivity.java`, `WorkspacePlugin.java`;
  iOS: `AppDelegate.swift`) keeps the in-app allow-list (workspace + sign-in + office host) at runtime
  via Capacitor's `shouldOverrideLoad`; any other link opens in the system browser. Capacitor's own
  bridge is only injected into the local launcher, never into the remote site.
- Change the server: long-press the app icon → **Change workspace** (Android), the offline screen,
  or `zentico://setup`.
- Android extras: back button walks history and backgrounds the app at the start; Drive downloads go
  through DownloadManager with the session cookie (page-generated `blob:` downloads are not supported);
  camera/mic prompts for meetings; native notifications while the app is running (origin-scoped
  WebView bridge). Screen sharing is not available in Android WebView.
- Push notifications when the app is closed need FCM (Android) / APNs (iOS): a Firebase project
  (`google-services.json`), an APNs key, and a server-side sender in the web app. Not set up.
- Android release: create an upload keystore (`keytool -genkeypair -v -keystore upload.jks -alias upload
  -keyalg RSA -keysize 2048 -validity 10000`), keep it out of git, reference it from
  `android/keystore.properties` (gitignored) in `app/build.gradle` `signingConfigs`, then
  `npm run build:release` → `.aab` for Play Console (enable Play App Signing).
- iOS: needs a Mac with Xcode and an Apple Developer account. `npx cap sync ios && npx cap open ios`,
  set the team/signing, archive and upload via Xcode/Transporter. The iOS plugin code has not been
  compiled yet; Web Notifications and the offline fallback are not wired on iOS.
