//! 클로드 마인드맵 - Tauri 판 (Electron main.js + src/core/*.js 를 Rust 로 옮긴 것)
//!
//! 화면(index.html, src/modules/*)은 그대로 쓰고, tauriIpc.js 가 window.ipcRenderer 를 만들어
//! 'ipc_send' 명령으로 보낸다. 일은 handlers::dispatch 가 하고, 답은 같은 이름의 이벤트로 보낸다.

pub mod app_dir;
pub mod approvals;
pub mod browser_bridge;
pub mod center_web;
pub mod claude_app;
pub mod claude_app_ax;
pub mod claude_runner;
pub mod git_panel;
pub mod github_map;
pub mod handlers;
pub mod ipc;
pub mod login_path;
pub mod machine_sync;
pub mod memo_store;
pub mod session_cwd;
pub mod session_indexer;
pub mod translate_web;
pub mod usage_meter;
pub mod web_control;

use std::sync::Arc;
use tauri::{Emitter, Manager};

#[tauri::command]
fn ipc_send(app: tauri::AppHandle, channel: String, payload: serde_json::Value) {
    let emit_app = app.clone();
    let ctx = ipc::Ctx::new(Arc::new(move |ch: &str, data: serde_json::Value| {
        if let Err(e) = emit_app.emit(ch, data) {
            eprintln!("emit {ch}: {e}");
        }
    }));
    // 무거운 일(기록 읽기, git, claude 실행)이 화면을 막지 않게 스레드에서
    std::thread::spawn(move || handlers::dispatch(&ctx, &channel, payload));
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            ipc_send,
            center_web::web_show,
            center_web::web_hide,
            center_web::web_go,
            center_web::web_url,
            translate_web::web_translate
        ])
        .setup(|app| {
            // Claude 가 앱 안 웹 화면을 조종하는 통로 (127.0.0.1 전용, 열쇠 파일)
            web_control::start(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if window.app_handle().webview_windows().is_empty() {
                    claude_runner::stop_all();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("클로드 마인드맵 실행 실패");
}
