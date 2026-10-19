fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["load_llm_settings", "save_llm_settings"]),
    ))
    .expect("failed to build Tauri application");
}
