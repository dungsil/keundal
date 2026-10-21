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
    selection: Option<Selection>,
}

#[derive(Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    provider: String,
    configuration: Option<String>,
    model: String,
    context_window: u32,
    max_output_tokens: u32,
}

impl Selection {
    fn validate(&self) -> Result<(), String> {
        if !matches!(self.provider.as_str(), "openai" | "anthropic" | "google")
            || self.model.trim().is_empty()
            || self.model.len() > 1024
            || self.model.chars().any(char::is_control)
            || self.context_window > 128_000
            || self.max_output_tokens == 0
            || self.max_output_tokens > 4096
            || self.max_output_tokens >= self.context_window
        {
            return Err("Invalid model selection".to_string());
        }
        if let Some(id) = &self.configuration {
            let prefix = format!("{}@", self.provider);
            let suffix = id.strip_prefix(&prefix).ok_or("Invalid provider configuration")?;
            if suffix.is_empty() || !suffix.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
                return Err("Invalid provider configuration".to_string());
            }
        }
        Ok(())
    }
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
    #[serde(flatten)]
    configurations: HashMap<String, ProviderSettings>,
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

fn provider(mut settings: LlmSettings, selected: Option<&Selection>) -> Result<Provider, String> {
    if let Some(selected) = selected {
        let (name, value) = match selected.provider.as_str() {
            "openai" => ("openai", settings.openai),
            "anthropic" => ("anthropic", settings.anthropic),
            _ => ("gemini", settings.google),
        };
        let value = if let Some(id) = &selected.configuration {
            settings
                .configurations
                .remove(id)
                .ok_or("Provider configuration was removed")?
        } else {
            value
        };
        return Ok(Provider {
            name,
            api_key: value.api_key,
            base_url: value.base_url,
            headers: value.headers,
        });
    }
    Ok([
        ("openai", settings.openai),
        ("anthropic", settings.anthropic),
        ("gemini", settings.google),
    ]
    .into_iter()
    .find(|(_, value)| {
        !value.api_key.trim().is_empty()
            || !value.base_url.trim().is_empty()
            || value
                .headers
                .as_ref()
                .is_some_and(|headers| !headers.is_empty())
    })
    .map(|(name, value)| Provider {
        name,
        api_key: value.api_key,
        base_url: value.base_url,
        headers: value.headers,
    })
    .unwrap_or(Provider {
        name: "openai",
        api_key: String::new(),
        base_url: String::new(),
        headers: None,
    }))
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
            .join("../dist-sidecar/main.js")
            .canonicalize()
            .map_err(|_| "Build the desktop sidecar before starting the app".to_string())?;
        return Ok((
            PathBuf::from("node"),
            vec![entry.to_string_lossy().into_owned()],
        ));
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

fn start(app: &tauri::AppHandle, selection: Option<Selection>) -> Result<Sidecar, String> {
    if let Some(selected) = selection.as_ref() {
        selected.validate()?;
    }
    let saved = settings::load_llm_settings_json()?;
    let parsed: LlmSettings = saved
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|_| "Stored LLM settings are invalid".to_string())?
        .unwrap_or_default();
    let provider = provider(parsed, selection.as_ref())?;

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
        .env("KEUNDAL_HOST", "127.0.0.1")
        .env("PORT", "0")
        .env("KEUNDAL_PARENT_PID", std::process::id().to_string())
        .env("KEUNDAL_API_TOKEN", &token)
        .env("KEUNDAL_MODEL", selection.as_ref().map(|value| value.model.clone()).unwrap_or_else(|| model_for(provider.name)))
        .env("KEUNDAL_PROVIDER", provider.name)
        .env(
            "KEUNDAL_CORS_ORIGINS",
            "http://tauri.localhost,https://tauri.localhost,tauri://localhost,http://localhost:1420",
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    if let Some(selected) = selection.as_ref() {
        command.env(
            "KEUNDAL_CONTEXT_WINDOW",
            selected.context_window.to_string(),
        );
        command.env(
            "KEUNDAL_MAX_OUTPUT_TOKENS",
            selected.max_output_tokens.to_string(),
        );
    }
    for key in ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"] {
        command.env_remove(key);
    }
    match provider.name {
        "openai" => command.env("OPENAI_API_KEY", &provider.api_key),
        "anthropic" => command.env("ANTHROPIC_API_KEY", &provider.api_key),
        _ => command.env("GEMINI_API_KEY", &provider.api_key),
    };
    command.env("KEUNDAL_BASE_URL", &provider.base_url);
    let headers = serde_json::to_string(&provider.headers.unwrap_or_default())
        .map_err(|_| "Could not encode request headers".to_string())?;
    command.env("KEUNDAL_HEADERS", headers);
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
                    let _ = sender.send(Err(
                        "The local Keundal host stopped before it was ready".to_string()
                    ));
                    return;
                }
                Ok(_) => {
                    if line.contains("\"kind\":\"keundal-sidecar\"") {
                        match serde_json::from_str::<Ready>(&line) {
                            Ok(ready) => {
                                let _ = sender.send(Ok(ready));
                            }
                            Err(_) => {
                                let _ = sender.send(Err(
                                    "The local Keundal host returned an invalid ready message"
                                        .to_string(),
                                ));
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
                    let _ = sender.send(Err(
                        "Could not read the local Keundal host output".to_string()
                    ));
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
            selection,
        }),
        Ok(Err(error)) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(error)
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            Err("The local Keundal host did not become ready".to_string())
        }
    }
}

#[tauri::command]
pub async fn sidecar_info(
    app: tauri::AppHandle,
    selection: Option<Selection>,
    restart: Option<bool>,
) -> Result<SidecarInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<SidecarState>();
        let mut current = state
            .0
            .lock()
            .map_err(|_| "Sidecar state is poisoned".to_string())?;
        if let Some(sidecar) = current.as_mut() {
            if !restart.unwrap_or(false)
                && sidecar.selection == selection
                && matches!(sidecar.child.try_wait(), Ok(None))
            {
                return Ok(SidecarInfo {
                    endpoint: sidecar.endpoint.clone(),
                    token: sidecar.token.clone(),
                });
            }
        }
        // Keep the previous process and connection usable if replacement startup fails.
        let sidecar = start(&app, selection)?;
        let info = SidecarInfo {
            endpoint: sidecar.endpoint.clone(),
            token: sidecar.token.clone(),
        };
        *current = Some(sidecar);
        Ok(info)
    })
    .await
    .map_err(|_| "Could not start the local Keundal host".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selection_uses_the_requested_provider_even_without_a_key() {
        let selected = Selection {
            provider: "google".into(),
            configuration: None,
            model: "custom-model".into(),
            context_window: 8000,
            max_output_tokens: 1000,
        };
        assert!(selected.validate().is_ok());
        let settings = LlmSettings {
            openai: ProviderSettings {
                api_key: "other-key".into(),
                ..Default::default()
            },
            google: ProviderSettings {
                base_url: "http://localhost:9000".into(),
                ..Default::default()
            },
            ..Default::default()
        };
        let chosen = provider(settings, Some(&selected)).unwrap();
        assert_eq!(chosen.name, "gemini");
        assert_eq!(chosen.api_key, "");
        assert_eq!(chosen.base_url, "http://localhost:9000");
    }

    #[test]
    fn named_configuration_uses_its_own_credentials_and_rejects_missing_entries() {
        let mut selected = Selection {
            provider: "openai".into(),
            configuration: Some("openai@work".into()),
            model: "shared".into(),
            context_window: 8000,
            max_output_tokens: 1000,
        };
        assert!(selected.validate().is_ok());
        let settings: LlmSettings = serde_json::from_str(r#"{
            "openai": {"apiKey":"default-key"},
            "openai@work": {"name":"Work","apiKey":"work-key","baseURL":"https://work.example/v1"}
        }"#).unwrap();
        let chosen = provider(settings, Some(&selected)).unwrap();
        assert_eq!(chosen.name, "openai");
        assert_eq!(chosen.api_key, "work-key");
        assert_eq!(chosen.base_url, "https://work.example/v1");
        assert!(provider(LlmSettings::default(), Some(&selected)).is_err());
        selected.configuration = Some("google@work".into());
        assert!(selected.validate().is_err());
    }

    #[test]
    fn selection_rejects_unknown_providers_and_invalid_budgets() {
        let mut selected = Selection {
            provider: "unknown".into(),
            configuration: None,
            model: "custom-model".into(),
            context_window: 8000,
            max_output_tokens: 1000,
        };
        assert!(selected.validate().is_err());
        selected.provider = "openai".into();
        selected.max_output_tokens = selected.context_window;
        assert!(selected.validate().is_err());
        selected.max_output_tokens = 1000;
        selected.model = "\n".into();
        assert!(selected.validate().is_err());
    }
}
