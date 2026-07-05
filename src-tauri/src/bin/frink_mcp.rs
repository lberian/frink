// frink_mcp — conector MCP (stdio) de Frink.
// Claude lo lanza como servidor MCP local (claude_desktop_config.json) y este
// binario reenvía cada herramienta a la app Frink en ejecución (API HTTP local
// en 127.0.0.1:4519). Si Frink no está abierto, responde con un error claro.

use serde_json::{json, Value};
use std::io::{BufRead, Write};

const BASE: &str = "http://127.0.0.1:4519";

fn agent(timeout_s: u64) -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(timeout_s))
        .build()
}

fn http_get(path: &str, timeout_s: u64) -> Result<Value, String> {
    agent(timeout_s)
        .get(&format!("{BASE}{path}"))
        .call()
        .map_err(|e| format!("No puedo hablar con Frink — ¿está abierto? ({e})"))?
        .into_json()
        .map_err(|e| e.to_string())
}

fn http_post(path: &str, body: Value, timeout_s: u64) -> Result<Value, String> {
    agent(timeout_s)
        .post(&format!("{BASE}{path}"))
        .send_json(body)
        .map_err(|e| format!("No puedo hablar con Frink — ¿está abierto? ({e})"))?
        .into_json()
        .map_err(|e| e.to_string())
}

fn tools_list() -> Value {
    json!({
        "tools": [
            {
                "name": "frink_latest",
                "description": "Devuelve la anotación más reciente hecha por el usuario con Frink: rutas del PNG anotado y del JSON, y el contenido del JSON (trazos, textos y coordenadas exactas en píxeles de la imagen original).",
                "inputSchema": { "type": "object", "properties": {} }
            },
            {
                "name": "frink_list",
                "description": "Lista las últimas anotaciones de Frink (pares PNG+JSON), más recientes primero. Filtro opcional por nombre de archivo.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "n": { "type": "integer", "description": "cuántas devolver (defecto 10)" },
                        "contains": { "type": "string", "description": "filtro: el nombre debe contener este texto" }
                    }
                }
            },
            {
                "name": "frink_annotate",
                "description": "Pide al usuario una anotación: abre Frink en su pantalla con la imagen indicada y un mensaje con lo que necesitas que marque. RESPONDE INMEDIATAMENTE (solicitud mostrada); el resultado se recoge llamando después a frink_wait. Úsala cuando necesites que el usuario señale, corrija o elija algo sobre una imagen: es más precisa que pedirle una descripción.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "image_path": { "type": "string", "description": "ruta absoluta de la imagen a anotar (en el equipo del usuario)" },
                        "prompt": { "type": "string", "description": "qué le pides al usuario que marque (se muestra en pantalla)" }
                    },
                    "required": ["image_path"]
                }
            },
            {
                "name": "frink_wait",
                "description": "Recoge el resultado de la última frink_annotate. Espera hasta ~45 s: devuelve el par PNG+JSON si el usuario pulsó Enter, la cancelación si pulsó Esc, o status 'pendiente' si aún está dibujando (en ese caso, vuelve a llamar a frink_wait).",
                "inputSchema": { "type": "object", "properties": {} }
            }
        ]
    })
}

fn tool_result(v: Result<Value, String>) -> Value {
    match v {
        Ok(val) => json!({
            "content": [{ "type": "text", "text": serde_json::to_string_pretty(&val).unwrap_or_default() }],
            "isError": false
        }),
        Err(e) => json!({
            "content": [{ "type": "text", "text": e }],
            "isError": true
        }),
    }
}

fn tools_call(msg: &Value) -> Value {
    let params = msg.get("params").cloned().unwrap_or(json!({}));
    let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
    let args = params.get("arguments").cloned().unwrap_or(json!({}));
    match name {
        "frink_latest" => tool_result(http_get("/latest", 15)),
        "frink_list" => {
            let n = args.get("n").and_then(|v| v.as_u64()).unwrap_or(10);
            let contains = args
                .get("contains")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .replace(' ', "%20");
            tool_result(http_get(&format!("/list?n={n}&contains={contains}"), 15))
        }
        "frink_annotate" => tool_result(http_post("/annotate", args, 20)),
        "frink_wait" => tool_result(http_get("/wait?timeout_s=45", 55)),
        _ => tool_result(Err(format!("herramienta desconocida: {name}"))),
    }
}

fn main() {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let id = msg.get("id").cloned();
        let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");

        // Las notificaciones (sin id) no se responden.
        let Some(id) = id else { continue };

        let response = match method {
            "initialize" => {
                let proto = msg
                    .pointer("/params/protocolVersion")
                    .and_then(|v| v.as_str())
                    .unwrap_or("2024-11-05")
                    .to_string();
                json!({"jsonrpc": "2.0", "id": id, "result": {
                    "protocolVersion": proto,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "frink", "version": "0.5.0" }
                }})
            }
            "tools/list" => json!({"jsonrpc": "2.0", "id": id, "result": tools_list()}),
            "tools/call" => json!({"jsonrpc": "2.0", "id": id, "result": tools_call(&msg)}),
            "ping" => json!({"jsonrpc": "2.0", "id": id, "result": {}}),
            _ => json!({"jsonrpc": "2.0", "id": id, "error": {
                "code": -32601, "message": format!("método no soportado: {method}")
            }}),
        };
        let mut out = stdout.lock();
        let _ = writeln!(out, "{}", response);
        let _ = out.flush();
    }
}
