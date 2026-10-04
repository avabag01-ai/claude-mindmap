//! 클로드 앱 붙이기: 마인드맵 창 오른쪽에 클로드 앱 창을 같은 높이로 딱 붙인다 (대화창 자리).
//! 다른 앱 창을 우리 창 안에 넣을 수는 없어서(맥), 마인드맵은 대화창 폭만큼 줄이고 그 옆에 클로드 앱 창을 둔다.
//! 마인드맵을 옮기거나 크기를 바꾸면 따라오고, 마인드맵을 누르면 클로드 앱 창도 위로 올린다(앱은 앞으로 안 옴).
//! 화면은 src/modules/HubClaudeDock.js, 클로드 앱 창 다루기는 claude_app_ax.rs (place_window·raise_window).

use crate::claude_app_ax;
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{LogicalPosition, LogicalSize, WebviewWindow, Window};

/// 붙인 동안: 클로드 앱 창 폭(점), 마인드맵에서 줄인 폭(점) — 떼면 그만큼 되돌린다
struct Dock {
    claude_w: f64,
    shrunk: f64,
}

static DOCK: Mutex<Option<Dock>> = Mutex::new(None);

/// 마인드맵 창 (점 단위): 왼쪽 위 x, y, 폭, 높이
fn frame(win: &Window) -> Option<(f64, f64, f64, f64)> {
    let k = win.scale_factor().ok()?;
    let p = win.outer_position().ok()?;
    let s = win.outer_size().ok()?;
    Some((p.x as f64 / k, p.y as f64 / k, s.width as f64 / k, s.height as f64 / k))
}

/// 마인드맵 오른쪽에 클로드 앱 창을 둔다. 실제 자리·크기를 돌려준다
fn place(win: &Window, claude_w: f64) -> Option<(f64, f64, f64, f64)> {
    let (x, y, w, h) = frame(win)?;
    claude_app_ax::place_window(x + w, y, claude_w, h)
}

/// 화면 버튼: on = 붙이기, width = 클로드 앱 창 폭(지금 대화창 폭)
#[tauri::command]
pub fn claude_dock(window: WebviewWindow, on: bool, width: f64) -> Result<Value, String> {
    let win = window.as_ref().window();
    let mut st = DOCK.lock().unwrap();
    if !on {
        if let Some(d) = st.take() {
            if let Some((_, _, w, h)) = frame(&win) {
                let _ = win.set_size(LogicalSize::new(w + d.shrunk, h));
            }
        }
        return Ok(json!({ "ok": true, "on": false }));
    }
    if st.is_some() {
        return Ok(json!({ "ok": true, "on": true }));
    }
    let claude_w = width.max(420.0);
    let (x, y, w, h) = frame(&win).ok_or("마인드맵 창 크기를 못 읽었어요")?;
    // 화면 오른쪽 끝을 넘으면 마인드맵을 왼쪽으로 민다
    let (sx, sw) = win
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let k = m.scale_factor();
            (m.position().x as f64 / k, m.size().width as f64 / k)
        })
        .unwrap_or((0.0, f64::MAX));
    let shrunk = width.max(0.0).min(w - 600.0).max(0.0);
    let new_w = w - shrunk;
    let over = (x + new_w + claude_w) - (sx + sw);
    if over > 0.0 {
        let _ = win.set_position(LogicalPosition::new((x - over).max(sx), y));
    }
    let _ = win.set_size(LogicalSize::new(new_w, h));
    let (nx, ny) = (if over > 0.0 { (x - over).max(sx) } else { x }, y);
    let got = claude_app_ax::place_window(nx + new_w, ny, claude_w, h);
    let Some((_, _, gw, _)) = got else {
        let _ = win.set_size(LogicalSize::new(w, h));
        let _ = win.set_position(LogicalPosition::new(x, y));
        return Err("클로드 앱 창을 못 찾았어요. 클로드 앱이 켜져 있고 마인드맵에 손쉬운 사용 권한이 있어야 해요".into());
    };
    claude_app_ax::raise_window();
    *st = Some(Dock { claude_w: gw, shrunk });
    Ok(json!({ "ok": true, "on": true, "width": gw }))
}

/// 창 이벤트: 붙인 동안 옮기기·크기 바꾸기를 따라가고, 마인드맵을 누르면 클로드 앱 창도 위로
pub fn on_window_event(win: &Window, ev: &tauri::WindowEvent) {
    let claude_w = match DOCK.lock().unwrap().as_ref() {
        Some(d) => d.claude_w,
        None => return,
    };
    match ev {
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
            place(win, claude_w);
        }
        tauri::WindowEvent::Focused(true) => {
            place(win, claude_w);
            claude_app_ax::raise_window();
        }
        _ => {}
    }
}
