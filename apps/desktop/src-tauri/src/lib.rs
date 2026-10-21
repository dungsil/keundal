mod settings;
mod sidecar;
mod skills;

pub fn run() {
    let app = tauri::Builder::default()
        .manage(sidecar::SidecarState::default())
        .invoke_handler(tauri::generate_handler![
            settings::load_llm_settings,
            settings::save_llm_settings,
            settings::load_mcp_settings,
            settings::save_mcp_settings,
            skills::list_skill_files,
            skills::read_skill_file,
            sidecar::sidecar_info
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Keundal desktop application");
    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            use tauri::Manager;
            if let Some(state) = app.try_state::<sidecar::SidecarState>() {
                state.stop();
            }
        }
    });
}
