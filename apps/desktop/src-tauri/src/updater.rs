use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::menu::{Menu, MenuEvent, MenuItem, SubmenuBuilder};
use tauri::{App, AppHandle, Manager, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

use crate::sidecar::SidecarState;

const CHECK_UPDATE: &str = "check-update";

struct UpdateState {
    busy: AtomicBool,
    item: MenuItem<Wry>,
}

pub fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let menu = Menu::default(app.handle())?;
    let item = MenuItem::with_id(app, CHECK_UPDATE, "Check for Updates…", true, None::<&str>)?;
    menu.append(&SubmenuBuilder::new(app, "Updates").item(&item).build()?)?;
    app.set_menu(menu)?;
    app.manage(UpdateState {
        busy: AtomicBool::new(false),
        item,
    });
    Ok(())
}

pub fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    if event.id().as_ref() != CHECK_UPDATE {
        return;
    }
    let state = app.state::<UpdateState>();
    if state.busy.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = state.item.set_enabled(false);
    let _ = state.item.set_text("Checking for Updates…");
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = check_and_install(&app).await {
            app.dialog()
                .message(format!("The update could not be completed. Your saved data has not been removed.\n\n{error}"))
                .title("Keundal Update")
                .kind(MessageDialogKind::Error)
                .blocking_show();
        }
        let state = app.state::<UpdateState>();
        let _ = state.item.set_text("Check for Updates…");
        let _ = state.item.set_enabled(true);
        state.busy.store(false, Ordering::SeqCst);
    });
}

async fn check_and_install(
    app: &AppHandle,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("pubkey"))
        .and_then(|key| key.as_str())
        .unwrap_or_default()
        .is_empty()
    {
        return Err("Updates are available only in signed release builds. Install an official release first.".into());
    }
    #[cfg(target_os = "linux")]
    if app.env().appimage.is_none() {
        return Err("Automatic updates require the official AppImage. DEB installations must be updated using a new DEB package.".into());
    }
    let exit_app = app.clone();
    let updater = app
        .updater_builder()
        .timeout(Duration::from_secs(120))
        // Windows installers exit without emitting Tauri's RunEvent::Exit.
        .on_before_exit(move || exit_app.state::<SidecarState>().stop())
        .build()?;
    let Some(update) = updater.check().await? else {
        app.dialog()
            .message(format!(
                "Keundal {} is up to date.",
                app.package_info().version
            ))
            .title("Keundal Update")
            .blocking_show();
        return Ok(());
    };
    let confirmed = app.dialog()
        .message(format!(
            "Install Keundal {} (current: {})?\n\nThe download is verified before installation. The app will close and restart; active responses will stop. Saved settings and conversations are kept. Finish your work before continuing.",
            update.version, app.package_info().version
        ))
        .title("Keundal Update")
        .buttons(MessageDialogButtons::OkCancelCustom("Install and Restart".into(), "Later".into()))
        .blocking_show();
    if !confirmed {
        return Ok(());
    }
    let _ = app
        .state::<UpdateState>()
        .item
        .set_text("Downloading and Verifying…");
    // download() verifies the signature. Never stop the host or install unverified bytes.
    let bytes = update.download(|_, _| {}, || {}).await?;
    let _ = app
        .state::<UpdateState>()
        .item
        .set_text("Installing Update…");
    update.install(bytes)?;
    // Windows restarts via NSIS; macOS/Linux return after replacing the application.
    app.state::<SidecarState>().stop();
    app.restart();
}
