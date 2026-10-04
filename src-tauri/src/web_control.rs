//! 앱 안 웹 화면(가운데 GitHub·브라우저 탭, center_web.rs)을 Claude 가 조종하는 통로.
//! - 127.0.0.1 의 아무 포트에서만 듣는다 (맥 바깥에서 못 들어옴). 포트와 열쇠는 ~/.claude-mindmap/web-control.json (0600)
//! - 한 줄 JSON 요청 → 한 줄 JSON 답. 열쇠가 다르면 거절.
//!   { token, label: "github"|"web", op: "status"|"eval"|"open"|"back"|"forward"|"reload", js?, url? }
//! - eval 은 그 웹 화면에서 스크립트를 돌리고 마지막 식의 값을 JSON 문자열로 돌려준다.
//! - open 은 화면에 알려(center-web:open) 그 탭으로 바꾸고 주소를 연다 — 사용자가 보는 화면과 같은 곳.
//! 쓰는 쪽: src/core/AppWebBridge.js (scripts/mindmap-browser-mcp.js 의 browser: app-github · app-web)

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::center_web::parse_url;

const LABELS: [&str; 2] = ["github", "web"];

pub fn start(app: AppHandle) {
    let listener = match TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(e) => { eprintln!("web-control: {e}"); return; }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let token = uuid::Uuid::new_v4().simple().to_string();
    if let Err(e) = write_info(port, &token) { eprintln!("web-control 파일: {e}"); return; }
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let (app, token) = (app.clone(), token.clone());
            std::thread::spawn(move || serve(&app, &token, stream));
        }
    });
}

fn write_info(port: u16, token: &str) -> std::io::Result<()> {
    let path = crate::app_dir::settings_file("web-control.json");
    if let Some(dir) = path.parent() { std::fs::create_dir_all(dir)?; }
    let body = json!({ "port": port, "token": token, "pid": std::process::id() }).to_string();
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; o.mode(0o600); }
    let mut f = o.open(&path)?;
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?; }
    f.write_all(body.as_bytes())
}

fn serve(app: &AppHandle, token: &str, stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let mut out = match stream.try_clone() { Ok(s) => s, Err(_) => return };
    let mut line = String::new();
    if BufReader::new(stream).read_line(&mut line).is_err() { return; }
    let reply = match serde_json::from_str::<Value>(&line) {
        Ok(req) => handle(app, token, &req),
        Err(_) => json!({ "ok": false, "error": "JSON 이 아니에요" }),
    };
    let _ = writeln!(out, "{reply}");
}

/// 요청 확인만 (열쇠·라벨·동작). 통과하면 (label, op)
pub fn check(token: &str, req: &Value) -> Result<(String, String), String> {
    let s = |k: &str| req.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    if token.is_empty() || s("token") != token { return Err("열쇠가 맞지 않아요".into()); }
    let label = s("label");
    if !LABELS.contains(&label.as_str()) { return Err(format!("모르는 웹 화면: {label} (github · web)")); }
    let op = s("op");
    if !["status", "eval", "open", "back", "forward", "reload"].contains(&op.as_str()) { return Err(format!("모르는 동작: {op}")); }
    Ok((label, op))
}

fn handle(app: &AppHandle, token: &str, req: &Value) -> Value {
    let (label, op) = match check(token, req) { Ok(x) => x, Err(e) => return json!({ "ok": false, "error": e }) };
    let tab = if label == "github" { "github" } else { "browser" };
    let view = app.get_webview(&label);
    match op.as_str() {
        "status" => json!({ "ok": true, "open": view.is_some(), "url": view.as_ref().and_then(|v| v.url().ok()).map(|u| u.to_string()) }),
        "open" => {
            let Some(u) = req.get("url").and_then(Value::as_str).and_then(parse_url) else {
                return json!({ "ok": false, "error": "https·http 주소를 주세요" });
            };
            match app.emit("center-web:open", json!({ "tab": tab, "url": u.to_string() })) {
                Ok(_) => json!({ "ok": true, "url": u.to_string() }),
                Err(e) => json!({ "ok": false, "error": e.to_string() }),
            }
        }
        _ => {
            let Some(v) = view else {
                return json!({ "ok": false, "error": format!("앱에서 가운데 {} 탭이 아직 안 열렸어요 (open 으로 열 수 있어요)", if tab == "github" { "GitHub" } else { "브라우저" }) });
            };
            match op.as_str() {
                "reload" => v.reload().map(|_| json!({ "ok": true })).unwrap_or_else(|e| json!({ "ok": false, "error": e.to_string() })),
                "back" | "forward" => {
                    let _ = v.eval(if op == "back" { "history.back()" } else { "history.forward()" });
                    json!({ "ok": true })
                }
                _ => {
                    let js = req.get("js").and_then(Value::as_str).unwrap_or("").to_string();
                    let (tx, rx) = mpsc::channel();
                    if let Err(e) = v.eval_with_callback(js, move |r| { let _ = tx.send(r); }) {
                        return json!({ "ok": false, "error": e.to_string() });
                    }
                    match rx.recv_timeout(Duration::from_secs(20)) {
                        Ok(r) => json!({ "ok": true, "result": r }),
                        Err(_) => json!({ "ok": false, "error": "페이지에서 답이 없어요 (20초)" }),
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn needs_token_label_op() {
        let ok = json!({ "token": "k", "label": "web", "op": "eval", "js": "1" });
        assert_eq!(check("k", &ok).unwrap(), ("web".into(), "eval".into()));
        assert!(check("k", &json!({ "token": "x", "label": "web", "op": "eval" })).is_err());
        assert!(check("", &json!({ "token": "", "label": "web", "op": "eval" })).is_err());
        assert!(check("k", &json!({ "token": "k", "label": "main", "op": "eval" })).is_err());
        assert!(check("k", &json!({ "token": "k", "label": "github", "op": "close" })).is_err());
    }
}
