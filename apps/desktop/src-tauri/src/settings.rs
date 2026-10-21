use keyring::{Entry, Error};

fn settings_entry() -> Result<Entry, String> {
    Entry::new("com.keundal.desktop", "llm-settings")
        .map_err(|_| "Could not access the OS secret store".to_string())
}

#[tauri::command]
pub async fn load_llm_settings() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| match settings_entry()?.get_password() {
        Ok(settings) => Ok(Some(settings)),
        Err(Error::NoEntry) => Ok(None),
        Err(_) => Err("Could not read LLM settings from the OS secret store".to_string()),
    })
    .await
    .map_err(|_| "Could not read LLM settings from the OS secret store".to_string())?
}

#[tauri::command]
pub async fn save_llm_settings(settings: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = settings_entry()?;
        match settings {
            Some(settings) => entry
                .set_password(&settings)
                .map_err(|_| "Could not save LLM settings in the OS secret store".to_string()),
            None => match entry.delete_credential() {
                Ok(()) | Err(Error::NoEntry) => Ok(()),
                Err(_) => Err("Could not remove LLM settings from the OS secret store".to_string()),
            },
        }
    })
    .await
    .map_err(|_| "Could not update LLM settings in the OS secret store".to_string())?
}

pub fn load_llm_settings_json() -> Result<Option<String>, String> {
    match settings_entry()?.get_password() {
        Ok(settings) => Ok(Some(settings)),
        Err(Error::NoEntry) => Ok(None),
        Err(_) => Err("Could not read LLM settings from the OS secret store".to_string()),
    }
}

fn mcp_settings_entry() -> Result<Entry, String> {
    Entry::new("com.keundal.desktop", "mcp-settings")
        .map_err(|_| "Could not access the OS secret store".to_string())
}

#[tauri::command]
pub async fn load_mcp_settings() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| match mcp_settings_entry()?.get_password() {
        Ok(settings) => Ok(Some(settings)),
        Err(Error::NoEntry) => Ok(None),
        Err(_) => Err("Could not read MCP settings from the OS secret store".to_string()),
    })
    .await
    .map_err(|_| "Could not read MCP settings from the OS secret store".to_string())?
}

#[tauri::command]
pub async fn save_mcp_settings(settings: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = mcp_settings_entry()?;
        match settings {
            Some(settings) => entry
                .set_password(&settings)
                .map_err(|_| "Could not save MCP settings in the OS secret store".to_string()),
            None => match entry.delete_credential() {
                Ok(()) | Err(Error::NoEntry) => Ok(()),
                Err(_) => Err("Could not remove MCP settings from the OS secret store".to_string()),
            },
        }
    })
    .await
    .map_err(|_| "Could not update MCP settings in the OS secret store".to_string())?
}

pub fn load_mcp_settings_json() -> Result<Option<String>, String> {
    match mcp_settings_entry()?.get_password() {
        Ok(settings) => Ok(Some(settings)),
        Err(Error::NoEntry) => Ok(None),
        Err(_) => Err("Could not read MCP settings from the OS secret store".to_string()),
    }
}
