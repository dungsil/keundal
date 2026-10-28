fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "load_llm_settings",
            "save_llm_settings",
            "load_mcp_settings",
            "save_mcp_settings",
            "list_skill_files",
            "read_skill_file",
            "runtime_plugins",
            "sidecar_info",
            "sidecar_current_info",
        ]),
    ))
    .expect("failed to build Tauri application");
}
