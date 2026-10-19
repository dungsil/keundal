mod settings;

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            settings::load_llm_settings,
            settings::save_llm_settings
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Keundal desktop application");
}
