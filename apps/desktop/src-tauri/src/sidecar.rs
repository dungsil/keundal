use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::settings;

#[derive(Default)]
pub struct SidecarState(Mutex<Option<Sidecar>>);

struct Sidecar {
    endpoint: String,
    token: String,
    child: Child,
}

impl SidecarState {
    pub fn stop(&self) {
        if let Ok(mut sidecar) = self.0.lock() {
            sidecar.take();
        }
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Serialize, Clone)]
pub struct SidecarInfo {
    endpoint: String,
    token: String,
}

#[derive(Deserialize)]
struct Ready {
    url: String,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct ProviderSettings {
    api_key: String,
    #[serde(rename = "baseURL")]
    base_url: String,
    headers: Option<HashMap<String, String>>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct LlmSettings {
    openai: ProviderSettings,
    anthropic: ProviderSettings,
    google: ProviderSettings,
}

struct Provider {
    name: &'static str,
    api_key: String,
    base_url: String,
    headers: Option<HashMap<String, String>>,
}

fn provider(settings: LlmSettings) -> Option<Provider> {
    [
        ("openai", settings.openai),
        ("anthropic", settings.anthropic),
        ("gemini", settings.google),
    ]
    .into_iter()
    .find(|(_, value)| !value.api_key.trim().is_empty())
    .map(|(name, value)| Provider {
        name,
        api_key: value.api_key,
        base_url: value.base_url,
        headers: value.headers,
    })
}

fn model_for(provider: &str) -> String {
    if let Ok(model) = std::env::var("KEUNDAL_MODEL") {
        if !model.trim().is_empty() {
            return model;
        }
    }
    match provider {
        "openai" => "gpt-4.1-mini".to_string(),
        "anthropic" => "claude-haiku-4-5".to_string(),
        _ => "gemini-2.5-flash".to_string(),
    }
}

fn sidecar_command() -> Result<(PathBuf, Vec<String>), String> {
    if cfg!(debug_assertions) {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let entry = manifest
            .join("../../server/dist/main.js")
            .canonicalize()
            .map_err(|_| "Build @keundal/server before starting the desktop app".to_string())?;
        return Ok((PathBuf::from("node"), vec![entry.to_string_lossy().into_owned()]));
    }

    let current = std::env::current_exe()
        .map_err(|_| "Could not locate the application executable".to_string())?;
    let directory = current
        .parent()
        .ok_or_else(|| "Could not locate the application directory".to_string())?;
    let binary = directory.join(if cfg!(windows) {
        "keundal-host.exe"
    } else {
        "keundal-host"
    });
    Ok((binary, Vec::new()))
}

fn resource_entry(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.path()
        .resource_dir()
        .map(|directory| directory.join("sidecar").join("main.js"))
        .map_err(|_| "Could not locate the sidecar resources".to_string())
}

fn start(app: &tauri::AppHandle) -> Result<Sidecar, String> {
    let saved = settings::load_llm_settings_json()?;
    let parsed: LlmSettings = saved
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|_| "Stored LLM settings are invalid".to_string())?
        .unwrap_or_default();
    let provider = provider(parsed)
        .ok_or_else(|| "Add an LLM API key in LLM settings before starting the local host".to_string())?;

    let (binary, mut args) = sidecar_command()?;
    if !cfg!(debug_assertions) {
        args.push(resource_entry(app)?.to_string_lossy().into_owned());
    }
    if args.is_empty() {
        return Err("The sidecar entry point is missing".to_string());
    }

    let token = uuid::Uuid::new_v4().simple().to_string();
    let mut command = Command::new(&binary);
    command
        .args(&args)
        .env("KEUNDAL_SIDECAR", "1")
        .env("KEUNDAL_PARENT_PID", std::process::id().to_string())
        .env("KEUNDAL_API_TOKEN", &token)
        .env("KEUNDAL_MODEL", model_for(provider.name))
        .env("KEUNDAL_PROVIDER", provider.name)
        .env(
            "KEUNDAL_CORS_ORIGINS",
            "http://tauri.localhost,https://tauri.localhost,tauri://localhost,http://localhost:1420",
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    match provider.name {
        "openai" => command.env("OPENAI_API_KEY", &provider.api_key),
        "anthropic" => command.env("ANTHROPIC_API_KEY", &provider.api_key),
        _ => command.env("GEMINI_API_KEY", &provider.api_key),
    };
    if !provider.base_url.trim().is_empty() {
        command.env("KEUNDAL_BASE_URL", &provider.base_url);
    }
    if let Some(headers) = provider.headers {
        if !headers.is_empty() {
            let value = serde_json::to_string(&headers)
                .map_err(|_| "Could not encode request headers".to_string())?;
            command.env("KEUNDAL_HEADERS", value);
        }
    }
    if let Ok(data) = app.path().app_data_dir() {
        std::fs::create_dir_all(&data).ok();
        command.env("KEUNDAL_SQLITE_PATH", data.join("keundal.sqlite"));
    }

    let mut child = command
        .spawn()
        .map_err(|_| "Could not start the local Keundal host".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "The local Keundal host did not expose stdout".to_string())?;
    let (sender, receiver) = mpsc::channel::<Result<Ready, String>>();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    let _ = sender.send(Err("The local Keundal host stopped before it was ready".to_string()));
                    return;
                }
                Ok(_) => {
                    if line.contains("\"kind\":\"keundal-sidecar\"") {
                        match serde_json::from_str::<Ready>(&line) {
                            Ok(ready) => {
                                let _ = sender.send(Ok(ready));
                            }
                            Err(_) => {
                                let _ = sender.send(Err("The local Keundal host returned an invalid ready message".to_string()));
                                return;
                            }
                        }
                        for line in reader.lines().map_while(Result::ok) {
                            eprintln!("[keundal-host] {line}");
                        }
                        return;
                    }
                    eprintln!("[keundal-host] {line}");
                }
                Err(_) => {
                    let _ = sender.send(Err("Could not read the local Keundal host output".to_string()));
                    return;
                }
            }
        }
    });

    match receiver.recv_timeout(Duration::from_secs(20)) {
        Ok(Ok(ready)) => Ok(Sidecar {
            endpoint: ready.url,
            token,
            child,
        }),
        Ok(Err(error)) => {
            let _ = child.kill();
            Err(error)
        }
        Err(_) => {
            let _ = child.kill();
            Err("The local Keundal host did not become ready".to_string())
        }
    }
}

#[tauri::command]
pub async fn sidecar_info(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
) -> Result<SidecarInfo, String> {
    if let Some(sidecar) = state.0.lock().map_err(|_| "Sidecar state is poisoned".to_string())?.as_ref() {
        return Ok(SidecarInfo {
            endpoint: sidecar.endpoint.clone(),
            token: sidecar.token.clone(),
        });
    }
    let sidecar = tauri::async_runtime::spawn_blocking(move || start(&app))
        .await
        .map_err(|_| "Could not start the local Keundal host".to_string())??;
    let info = SidecarInfo {
        endpoint: sidecar.endpoint.clone(),
        token: sidecar.token.clone(),
    };
    *state.0.lock().map_err(|_| "Sidecar state is poisoned".to_string())? = Some(sidecar);
    Ok(info)
}
