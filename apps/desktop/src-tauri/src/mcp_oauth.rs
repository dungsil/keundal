use std::process::{Command, Stdio};

use keyring::{Entry, Error};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
pub(crate) struct Request {
    pub id: u64,
    operation: String,
    key: Option<String>,
    value: Option<String>,
}

fn entry(key: Option<&str>) -> Result<Entry, String> {
    let key = key.ok_or("Missing credential key")?;
    if key != "callback-port" && (key.len() != 64 || !key.bytes().all(|b| b.is_ascii_hexdigit())) {
        return Err("Invalid credential key".into());
    }
    Entry::new("com.keundal.desktop.mcp-oauth", key)
        .map_err(|_| "Could not access the OS secret store".into())
}

pub(crate) fn execute(request: &Request) -> Result<Value, String> {
    match request.operation.as_str() {
        "load" => match entry(request.key.as_deref())?.get_password() {
            Ok(value) => Ok(Value::String(value)),
            Err(Error::NoEntry) => Ok(Value::Null),
            Err(_) => Err("Could not read MCP credentials".into()),
        },
        "save" => {
            let entry = entry(request.key.as_deref())?;
            match request.value.as_deref() {
                Some(value) => entry.set_password(value).map_err(|_| "Could not save MCP credentials")?,
                None => match entry.delete_credential() {
                    Ok(()) | Err(Error::NoEntry) => (),
                    Err(_) => return Err("Could not remove MCP credentials".into()),
                },
            }
            Ok(Value::Null)
        }
        "open" => {
            let value = request.value.as_deref().ok_or("Missing authorization URL")?;
            let url = tauri::Url::parse(value).map_err(|_| "Invalid authorization URL")?;
            let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
            if (url.scheme() != "https" && !(url.scheme() == "http" && loopback))
                || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some()
            {
                return Err("Invalid authorization URL".into());
            }
            // No shell interpolation, renderer command, or arbitrary executable is allowed.
            #[cfg(target_os = "macos")]
            let mut command = { let mut c = Command::new("open"); c.arg(value); c };
            #[cfg(target_os = "windows")]
            let mut command = {
                use std::os::windows::process::CommandExt;
                let mut c = Command::new("rundll32.exe");
                c.args(["url.dll,FileProtocolHandler", value]);
                c.creation_flags(0x08000000);
                c
            };
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            let mut command = { let mut c = Command::new("xdg-open"); c.arg(value); c };
            let mut child = command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
                .spawn().map_err(|_| "Could not launch the system browser")?;
            // Some desktop launchers stay alive with the browser. Never block credential writes
            // on browser exit: the OAuth callback itself needs this same native control pipe.
            std::thread::spawn(move || { let _ = child.wait(); });
            Ok(Value::Null)
        }
        _ => Err("Unknown native MCP operation".into()),
    }
}
