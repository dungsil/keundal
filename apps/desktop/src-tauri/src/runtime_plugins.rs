use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::Manager;

// Serialize file updates from all windows, not just a single frontend connection.
static PLUGIN_OPERATIONS: Mutex<()> = Mutex::new(());

#[tauri::command]
pub async fn runtime_plugins(
    app: tauri::AppHandle,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = PLUGIN_OPERATIONS
            .lock()
            .map_err(|_| "Plugin state is poisoned")?;
        let directory = app
            .path()
            .app_data_dir()
            .map_err(|_| "Could not locate app data")?
            .join("runtime-plugins");
        let (binary, mut args) = crate::sidecar::sidecar_command()?;
        if !cfg!(debug_assertions) {
            args.push(
                crate::sidecar::resource_entry(&app)?
                    .to_string_lossy()
                    .into_owned(),
            );
        }
        let mut command = Command::new(binary);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .args(args)
            .arg("--manage-runtime-plugins")
            .env("KEUNDAL_MANAGED_PLUGINS", directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| "Could not start plugin manager")?;
        let input = serde_json::to_vec(&request).map_err(|_| "Invalid plugin request")?;
        child
            .stdin
            .take()
            .ok_or("Plugin manager input is unavailable")?
            .write_all(&input)
            .map_err(|_| "Could not send plugin request")?;
        let output = child
            .wait_with_output()
            .map_err(|_| "Could not wait for plugin manager")?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        serde_json::from_slice(&output.stdout)
            .map_err(|_| "Invalid plugin manager response".to_string())
    })
    .await
    .map_err(|_| "Plugin manager failed".to_string())?
}
