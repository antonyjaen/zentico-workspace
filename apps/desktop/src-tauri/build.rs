fn main() {
    // Declaring the app's commands makes them subject to capabilities: the remote page can
    // only call what the runtime "remote-workspace" capability grants (see lib.rs).
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["get_launch", "set_workspace", "notify"])),
    )
    .expect("failed to run tauri-build");
}
