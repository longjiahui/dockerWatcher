use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Manager};

pub const TRAY_ID: &str = "main-tray";
const MENU_TOGGLE: &str = "toggle";
const MENU_QUIT: &str = "quit";

pub fn build(app: &App) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, MENU_TOGGLE, "显示 / 隐藏监听窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("Docker Watcher")
        // left click toggles the window, the menu opens on right click
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            MENU_TOGGLE => toggle_window(app),
            MENU_QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_window(tray.app_handle());
            }
        });

    if let Some(icon) = tray_icon(app) {
        builder = builder.icon(icon);
    } else {
        eprintln!("[docker-watcher] 未能加载托盘图标，托盘图标可能不可见");
    }

    builder.build(app)?;
    Ok(())
}

fn tray_icon(app: &App) -> Option<Image<'_>> {
    if let Some(icon) = app.default_window_icon() {
        return Some(icon.clone());
    }

    // The default window icon comes from the icon resource `tauri-build` embeds, which
    // should always exist, but fall back to reading that resource directly rather than
    // shipping a tray icon with no image at all.
    #[cfg(windows)]
    {
        if let Ok(icon) = Image::from_app_icon_resource(32) {
            return Some(icon);
        }
    }

    None
}

fn toggle_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else {
        let _ = window.show();
        let _ = window.set_focus();
    }
}
