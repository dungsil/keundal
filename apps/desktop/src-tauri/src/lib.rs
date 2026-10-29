mod settings;
mod sidecar;
mod skills;
mod runtime_plugins;
mod mcp_oauth;
mod updater;

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(sidecar::SidecarState::default())
        .setup(updater::setup)
        .on_menu_event(updater::on_menu_event)
        .invoke_handler(tauri::generate_handler![
            settings::load_llm_settings,
            settings::save_llm_settings,
            settings::load_mcp_settings,
            settings::save_mcp_settings,
            skills::list_skill_files,
            skills::read_skill_file,
            runtime_plugins::runtime_plugins,
            sidecar::sidecar_info,
            sidecar::sidecar_current_info
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
