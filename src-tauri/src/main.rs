// Frink (Freeze + ink) v0.4 — backend Tauri
// El nombre es el modelo: congelar la pantalla, entintar encima.
// Modos: pantalla (Ctrl+Flecha arriba) y lámina (Ctrl+Flecha abajo): anotar un
// archivo de imagen a resolución nativa; exporta PNG + JSON con coordenadas exactas.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose, Engine as _};
use std::io::Cursor;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, PhysicalPosition, PhysicalSize,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Captura pendiente: se hace en el handler del atajo (ANTES de mostrar el
/// overlay, así nunca sale en la foto) y el frontend la recoge con grab_screen.
struct Captured(Mutex<Option<String>>);

/// Imagen pasada como argumento al arrancar ("Abrir con Frink").
struct StartupFile(Mutex<Option<String>>);

/// Petición del conector MCP: /annotate la arma y /wait recoge el resultado.
#[derive(Default)]
struct AwaitState {
    pending: bool,
    result: Option<serde_json::Value>,
}
struct McpAwait(Mutex<AwaitState>);

/// El frontend avisa si el usuario cancela (Esc) una anotación pedida por la IA.
#[tauri::command]
fn mcp_cancel(state: tauri::State<McpAwait>) {
    let mut st = state.0.lock().unwrap();
    if st.pending {
        st.pending = false;
        st.result = Some(serde_json::json!({
            "ok": false,
            "error": "El usuario canceló la anotación (Esc)"
        }));
    }
}

/// El frontend pregunta al arrancar si hay imagen que abrir en modo lámina.
#[tauri::command]
fn take_startup_file(state: tauri::State<StartupFile>) -> Option<String> {
    state.0.lock().unwrap().take()
}

/// Coloca y muestra la ventana para el modo lámina (lo pide el frontend
/// cuando arranca con imagen por argumento).
#[tauri::command]
fn show_lamina_window(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        place_on_cursor_monitor(&app, &win);
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn encode_png(img: image::RgbaImage) -> Result<String, String> {
    let mut buf = Cursor::new(Vec::new());
    img.write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(general_purpose::STANDARD.encode(buf.into_inner()))
}

/// Captura el monitor que contiene el punto (px físicos globales).
/// Devuelve (png_base64, x, y, ancho, alto) del monitor elegido.
fn capture_at(px: i32, py: i32) -> Result<(String, i32, i32, u32, u32), String> {
    let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
    if monitors.is_empty() {
        return Err("No hay monitor".into());
    }
    let idx = monitors
        .iter()
        .position(|m| {
            let (x, y, w, h) = (m.x(), m.y(), m.width() as i32, m.height() as i32);
            px >= x && px < x + w && py >= y && py < y + h
        })
        .unwrap_or(0); // si el cursor no cae en ninguno, el principal
    let m = &monitors[idx];
    let (x, y, w, h) = (m.x(), m.y(), m.width(), m.height());
    let img = m.capture_image().map_err(|e| e.to_string())?;
    Ok((encode_png(img)?, x, y, w, h))
}

/// El frontend recoge aquí la captura hecha al pulsar el atajo.
#[tauri::command]
fn grab_screen(state: tauri::State<Captured>) -> Result<String, String> {
    if let Some(b64) = state.0.lock().unwrap().take() {
        return Ok(b64);
    }
    capture_at(0, 0).map(|(b64, ..)| b64)
}

/// Lee una imagen del disco (modo lámina, vía drag & drop) y la devuelve en base64.
#[tauri::command]
fn load_image(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(general_purpose::STANDARD.encode(bytes))
}

/// Recibe el PNG final y opcionalmente el JSON de anotaciones.
/// Guarda ambos en la carpeta destino (Imágenes/Frink por defecto) y deja en el
/// portapapeles: la imagen (modo pantalla) o LOS DOS ARCHIVOS como lista de
/// archivos (modo lámina) — al pegar en un chat se adjuntan ambos a la vez.
#[tauri::command]
fn deliver(
    app: tauri::AppHandle,
    png_base64: String,
    folder: String,
    json: Option<String>,
    base_name: Option<String>,
    as_files: Option<bool>,
) -> Result<String, String> {
    let clean = png_base64.trim_start_matches("data:image/png;base64,");
    let bytes = general_purpose::STANDARD
        .decode(clean)
        .map_err(|e| e.to_string())?;

    // --- Carpeta destino: la configurada por el usuario (o Imágenes/Frink) ---
    let dir = if folder.trim().is_empty() {
        frink_dir(&app)?
    } else {
        std::path::PathBuf::from(folder)
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let stem = base_name
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "captura".into());
    let stamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let png_path = dir.join(format!("{stem}_frink_{stamp}.png"));
    std::fs::write(&png_path, &bytes).map_err(|e| e.to_string())?;

    let mut json_path: Option<std::path::PathBuf> = None;
    if let Some(j) = json {
        let p = dir.join(format!("{stem}_frink_{stamp}.json"));
        std::fs::write(&p, j.as_bytes()).map_err(|e| e.to_string())?;
        json_path = Some(p);
    }

    // Si el conector MCP está esperando una anotación, dejarle el resultado.
    {
        let mcp = app.state::<McpAwait>();
        let mut st = mcp.0.lock().unwrap();
        if st.pending {
            st.pending = false;
            let ann = json_path
                .as_ref()
                .and_then(|p| std::fs::read_to_string(p).ok())
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
            st.result = Some(serde_json::json!({
                "ok": true,
                "png_path": png_path.to_string_lossy(),
                "json_path": json_path.as_ref().map(|p| p.to_string_lossy().to_string()),
                "annotations": ann,
            }));
        }
    }

    if as_files.unwrap_or(false) {
        // Portapapeles = lista de archivos (PNG + JSON): Ctrl+V adjunta los dos.
        #[cfg(windows)]
        {
            use clipboard_win::Setter as _;
            let mut files = vec![png_path.to_string_lossy().to_string()];
            if let Some(p) = &json_path {
                files.push(p.to_string_lossy().to_string());
            }
            let _clip = clipboard_win::Clipboard::new_attempts(10)
                .map_err(|e| format!("abrir portapapeles: {e:?}"))?;
            clipboard_win::formats::FileList
                .write_clipboard(&files[..])
                .map_err(|e| format!("portapapeles (archivos): {e:?}"))?;
        }
    } else {
        // Portapapeles = imagen (pegado visual instantáneo)
        let rgba = image::load_from_memory(&bytes)
            .map_err(|e| e.to_string())?
            .to_rgba8();
        let (w, h) = rgba.dimensions();
        let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        clipboard
            .set_image(arboard::ImageData {
                width: w as usize,
                height: h as usize,
                bytes: std::borrow::Cow::Owned(rgba.into_raw()),
            })
            .map_err(|e| e.to_string())?;
    }

    Ok(png_path.to_string_lossy().to_string())
}

/// Coloca la ventana cubriendo el monitor del cursor.
fn place_on_cursor_monitor(app: &tauri::AppHandle, win: &tauri::WebviewWindow) {
    let (cx, cy) = match app.cursor_position() {
        Ok(p) => (p.x as i32, p.y as i32),
        Err(_) => (0, 0),
    };
    if let Ok(monitors) = xcap::Monitor::all() {
        let found = monitors
            .iter()
            .find(|m| {
                let (x, y, w, h) = (m.x(), m.y(), m.width() as i32, m.height() as i32);
                cx >= x && cx < x + w && cy >= y && cy < y + h
            })
            .or_else(|| monitors.first());
        if let Some(m) = found {
            let _ = win.set_position(PhysicalPosition::new(m.x(), m.y()));
            let _ = win.set_size(PhysicalSize::new(m.width(), m.height()));
        }
    }
    // Modo overlay: fija, sin barra de tareas
    let _ = win.set_resizable(false);
    let _ = win.set_skip_taskbar(true);
}

/// La imagen ya cargó en modo lámina: expandir de la ventana pequeña
/// al monitor completo (lo invoca el frontend).
#[tauri::command]
fn expand_lamina(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        place_on_cursor_monitor(&app, &win);
        let _ = win.set_focus();
    }
}

/// Modo pantalla: congela el monitor del cursor y muestra el overlay.
fn trigger_capture(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let (cx, cy) = match app.cursor_position() {
            Ok(p) => (p.x as i32, p.y as i32),
            Err(_) => (0, 0),
        };
        if let Ok((b64, mx, my, mw, mh)) = capture_at(cx, cy) {
            *app.state::<Captured>().0.lock().unwrap() = Some(b64);
            let _ = win.set_position(PhysicalPosition::new(mx, my));
            let _ = win.set_size(PhysicalSize::new(mw, mh));
        }
        let _ = win.show();
        let _ = win.set_focus();
        let _ = win.emit("start-capture", ());
    }
}

/// Modo lámina: ventana PEQUEÑA y manejable (mover, redimensionar, minimizar,
/// visible en la barra de tareas) para elegir/soltar la imagen sin tapar el
/// escritorio. Al cargar la imagen, el frontend invoca expand_lamina.
fn trigger_file_mode(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let (cx, cy) = match app.cursor_position() {
            Ok(p) => (p.x as i32, p.y as i32),
            Err(_) => (0, 0),
        };
        let (mut w, mut h) = (640u32, 470u32);
        if let Ok(monitors) = xcap::Monitor::all() {
            let found = monitors
                .iter()
                .find(|m| {
                    let (x, y, mw, mh) = (m.x(), m.y(), m.width() as i32, m.height() as i32);
                    cx >= x && cx < x + mw && cy >= y && cy < y + mh
                })
                .or_else(|| monitors.first());
            if let Some(m) = found {
                // tamaño proporcional al monitor (aprox. 1/3), centrado
                w = (m.width() / 3).max(560);
                h = (m.height() / 3).max(420);
                let x = m.x() + (m.width() as i32 - w as i32) / 2;
                let y = m.y() + (m.height() as i32 - h as i32) / 2;
                let _ = win.set_size(PhysicalSize::new(w, h));
                let _ = win.set_position(PhysicalPosition::new(x, y));
            }
        }
        let _ = win.set_size(PhysicalSize::new(w, h));
        let _ = win.set_resizable(true);
        let _ = win.set_skip_taskbar(false);
        let _ = win.show();
        let _ = win.set_focus();
        let _ = win.emit("start-file-mode", ());
    }
}

/// Configuración persistente de Frink (config.json en AppData).
fn config_file(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("config.json"))
}

fn load_config(app: &tauri::AppHandle) -> serde_json::Value {
    config_file(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

fn save_dest_folder(app: &tauri::AppHandle, dir: &str) {
    let mut cfg = load_config(app);
    cfg["dest_folder"] = serde_json::Value::String(dir.to_string());
    if let Some(p) = config_file(app) {
        let _ = std::fs::write(p, serde_json::to_string_pretty(&cfg).unwrap_or_default());
    }
}

/// Carpeta de entregas: la elegida por el usuario o, por defecto, Imágenes/Frink.
fn frink_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    if let Some(d) = load_config(app)
        .get("dest_folder")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
    {
        return Ok(std::path::PathBuf::from(d));
    }
    Ok(app
        .path()
        .picture_dir()
        .map_err(|e| e.to_string())?
        .join("Frink"))
}

/// Lista los pares PNG+JSON de la carpeta Frink, más recientes primero.
fn list_pairs(app: &tauri::AppHandle, n: usize, contains: &str) -> serde_json::Value {
    let mut items: Vec<serde_json::Value> = Vec::new();
    if let Ok(dir) = frink_dir(app) {
        let mut jsons: Vec<std::path::PathBuf> = std::fs::read_dir(&dir)
            .map(|rd| {
                rd.filter_map(|e| e.ok().map(|e| e.path()))
                    .filter(|p| p.extension().map_or(false, |x| x == "json"))
                    .filter(|p| {
                        contains.is_empty()
                            || p.file_name()
                                .map(|f| f.to_string_lossy().to_lowercase())
                                .unwrap_or_default()
                                .contains(&contains.to_lowercase())
                    })
                    .collect()
            })
            .unwrap_or_default();
        jsons.sort();
        jsons.reverse(); // el timestamp del nombre ordena cronológicamente
        for p in jsons.into_iter().take(n) {
            let png = p.with_extension("png");
            let content = std::fs::read_to_string(&p)
                .ok()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
            items.push(serde_json::json!({
                "png_path": png.to_string_lossy(),
                "json_path": p.to_string_lossy(),
                "annotations": content,
            }));
        }
    }
    serde_json::json!(items)
}

fn respond_json(req: tiny_http::Request, code: u16, body: serde_json::Value) {
    let _ = req.respond(
        tiny_http::Response::from_string(body.to_string())
            .with_status_code(tiny_http::StatusCode(code))
            .with_header(
                "Content-Type: application/json"
                    .parse::<tiny_http::Header>()
                    .unwrap(),
            ),
    );
}

/// API HTTP local para el conector MCP (frink_mcp.exe). Solo escucha en 127.0.0.1.
fn start_mcp_http(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let server = match tiny_http::Server::http("127.0.0.1:4519") {
            Ok(s) => s,
            Err(e) => {
                eprintln!("Frink MCP http no arrancó: {e}");
                return;
            }
        };
        for mut req in server.incoming_requests() {
            let url = req.url().to_string();
            if url.starts_with("/latest") {
                let items = list_pairs(&app, 1, "");
                let pair = items.get(0).cloned().unwrap_or(serde_json::Value::Null);
                respond_json(req, 200, serde_json::json!({"ok": true, "pair": pair}));
            } else if url.starts_with("/list") {
                let q = url.splitn(2, '?').nth(1).unwrap_or("").to_string();
                let mut n = 10usize;
                let mut contains = String::new();
                for kv in q.split('&') {
                    let mut it = kv.splitn(2, '=');
                    match (it.next(), it.next()) {
                        (Some("n"), Some(v)) => n = v.parse().unwrap_or(10),
                        (Some("contains"), Some(v)) => {
                            contains = v.replace("%20", " ").replace('+', " ")
                        }
                        _ => {}
                    }
                }
                respond_json(
                    req,
                    200,
                    serde_json::json!({"ok": true, "pairs": list_pairs(&app, n, &contains)}),
                );
            } else if url.starts_with("/annotate") {
                let mut body = String::new();
                let _ = req.as_reader().read_to_string(&mut body);
                let v: serde_json::Value =
                    serde_json::from_str(&body).unwrap_or(serde_json::json!({}));
                let image_path = v
                    .get("image_path")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let prompt = v
                    .get("prompt")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                if !image_path.is_empty() && !std::path::Path::new(&image_path).is_file() {
                    respond_json(
                        req,
                        400,
                        serde_json::json!({"ok": false, "error": "image_path no existe"}),
                    );
                    continue;
                }
                {
                    let mcp = app.state::<McpAwait>();
                    let mut st = mcp.0.lock().unwrap();
                    st.pending = true;
                    st.result = None;
                }
                let app2 = app.clone();
                let _ = app.run_on_main_thread(move || {
                    if let Some(win) = app2.get_webview_window("main") {
                        place_on_cursor_monitor(&app2, &win);
                        let _ = win.show();
                        let _ = win.set_focus();
                        let _ = win.emit(
                            "mcp-annotate",
                            serde_json::json!({"path": image_path, "prompt": prompt}),
                        );
                    }
                });
                // Respuesta inmediata: el resultado se recoge con /wait.
                respond_json(req, 200, serde_json::json!({
                    "ok": true,
                    "status": "solicitud mostrada al usuario",
                    "next": "llama a frink_wait para recoger el resultado (Enter) o la cancelación (Esc)"
                }));
            } else if url.starts_with("/wait") {
                let q = url.splitn(2, '?').nth(1).unwrap_or("").to_string();
                let mut timeout_s: u64 = 45;
                for kv in q.split('&') {
                    let mut it = kv.splitn(2, '=');
                    if let (Some("timeout_s"), Some(v)) = (it.next(), it.next()) {
                        timeout_s = v.parse().unwrap_or(45).min(50);
                    }
                }
                let deadline =
                    std::time::Instant::now() + std::time::Duration::from_secs(timeout_s);
                let out = loop {
                    {
                        let mcp = app.state::<McpAwait>();
                        let mut st = mcp.0.lock().unwrap();
                        if let Some(r) = st.result.take() {
                            break r;
                        }
                        if !st.pending {
                            break serde_json::json!({"ok": false, "error": "no hay ninguna petición de anotación en curso"});
                        }
                    }
                    if std::time::Instant::now() >= deadline {
                        break serde_json::json!({"ok": false, "status": "pendiente", "next": "el usuario aún no ha terminado; vuelve a llamar a frink_wait"});
                    }
                    std::thread::sleep(std::time::Duration::from_millis(150));
                };
                respond_json(req, 200, out);
            } else {
                respond_json(
                    req,
                    404,
                    serde_json::json!({"ok": false, "error": "ruta desconocida"}),
                );
            }
        }
    });
}

fn main() {
    // Atajos: Ctrl+Flecha arriba = pantalla · Ctrl+Flecha abajo = lámina.
    let sc_screen = Shortcut::new(Some(Modifiers::CONTROL), Code::ArrowUp);
    let sc_lamina = Shortcut::new(Some(Modifiers::CONTROL), Code::ArrowDown);
    let sc_a = sc_screen.clone();
    let sc_l = sc_lamina.clone();

    // "Abrir con Frink": primer argumento que sea un archivo de imagen existente
    let startup_file = std::env::args().skip(1).find(|a| {
        let low = a.to_lowercase();
        std::path::Path::new(a).is_file()
            && [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"]
                .iter()
                .any(|ext| low.ends_with(ext))
    });

    tauri::Builder::default()
        .manage(Captured(Mutex::new(None)))
        .manage(StartupFile(Mutex::new(startup_file)))
        .manage(McpAwait(Mutex::new(AwaitState::default())))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, sc, event| {
                    if event.state() == ShortcutState::Pressed {
                        if sc == &sc_a {
                            trigger_capture(app);
                        } else if sc == &sc_l {
                            trigger_file_mode(app);
                        }
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            grab_screen,
            load_image,
            deliver,
            take_startup_file,
            show_lamina_window,
            expand_lamina,
            mcp_cancel
        ])
        .setup(move |app| {
            app.global_shortcut().register(sc_screen)?;
            app.global_shortcut().register(sc_lamina)?;

            // API local del conector MCP
            start_mcp_http(app.handle().clone());

            // --- Icono en la bandeja del sistema ---
            let capture =
                MenuItem::with_id(app, "capture", "Anotar pantalla (Ctrl+↑)", true, None::<&str>)?;
            let lamina =
                MenuItem::with_id(app, "lamina", "Anotar imagen… (Ctrl+↓)", true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let destino =
                MenuItem::with_id(app, "destino", "Elegir carpeta de destino…", true, None::<&str>)?;
            let abrir =
                MenuItem::with_id(app, "abrir", "Abrir carpeta de destino", true, None::<&str>)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Salir de Frink", true, None::<&str>)?;
            let menu =
                Menu::with_items(app, &[&capture, &lamina, &sep1, &destino, &abrir, &sep2, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Frink — Ctrl+↑ pantalla · Ctrl+↓ lámina")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "capture" => trigger_capture(app),
                    "lamina" => trigger_file_mode(app),
                    "destino" => {
                        let app2 = app.clone();
                        std::thread::spawn(move || {
                            if let Some(dir) = rfd::FileDialog::new()
                                .set_title("Carpeta donde Frink guardará los pares PNG + JSON")
                                .pick_folder()
                            {
                                save_dest_folder(&app2, &dir.to_string_lossy());
                            }
                        });
                    }
                    "abrir" => {
                        if let Ok(dir) = frink_dir(app) {
                            let _ = std::fs::create_dir_all(&dir);
                            let _ = std::process::Command::new("explorer").arg(dir).spawn();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error al arrancar Frink");
}
