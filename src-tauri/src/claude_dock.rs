//! 클로드 앱 붙이기: 대화창 칸의 가운데(대화 내용·입력칸 자리)를 투명한 구멍으로 만들고, 그 뒤에 클로드 앱 창을 딱 맞춰 둔다.
//! 다른 앱 창을 우리 창 안에 넣을 수는 없고(맥), 겹쳐 두면 마인드맵을 누를 때 클로드 창이 뒤로 가려진다(AXRaise 로도 안 올라옴, 10-04 실측).
//! 그래서 마인드맵 창을 투명 창으로 두고 그 자리만 비운다 — 위 머리줄·아래 버튼 줄은 마인드맵 것을 그대로 쓴다.
//! 마우스가 구멍 위에 있으면 마인드맵이 클릭을 받지 않아(set_ignore_cursor_events) 클릭이 클로드 창으로 간다.
//! 마인드맵을 옮기거나 크기를 바꾸면 따라온다. 화면은 src/modules/HubClaudeDock.js, 클로드 창 다루기는 claude_app_ax.rs.

use crate::claude_app_ax;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{WebviewWindow, Window};

/// 구멍 자리: 웹 화면 왼쪽 위 기준 CSS px (= 점)
#[derive(Clone, Copy, Deserialize, Debug, PartialEq)]
pub struct Hole {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

struct Dock {
    hole: Hole,
    /// 붙인 횟수 — 마우스 지켜보는 스레드가 떼거나 다시 붙이면 스스로 끝나게
    gen: u64,
}

static DOCK: Mutex<Option<Dock>> = Mutex::new(None);
static GEN: Mutex<u64> = Mutex::new(0);

/// 마인드맵 창 안쪽 왼쪽 위 (점)
fn origin(win: &Window) -> Option<(f64, f64)> {
    let k = win.scale_factor().ok()?;
    let p = win.inner_position().ok()?;
    Some((p.x as f64 / k, p.y as f64 / k))
}

/// 구멍 자리에 클로드 창을 둔다. 실제 크기(앱 최소 크기 때문에 더 클 수 있음)를 돌려준다
fn place(win: &Window, h: Hole) -> Option<(f64, f64)> {
    let (ox, oy) = origin(win)?;
    claude_app_ax::place_window(ox + h.x, oy + h.y, h.w, h.h).map(|(_, _, w, hh)| (w, hh))
}

/// 초록 단추를 확대로(붙인 동안) / 전체 화면으로(뗀 뒤)
fn set_fullscreen_allowed(win: &Window, allowed: bool) {
    if allowed == false && win.is_fullscreen().unwrap_or(false) {
        let _ = win.set_fullscreen(false);
    }
    let w = win.clone();
    let _ = win.run_on_main_thread(move || {
        if let Ok(ns) = w.ns_window() {
            claude_app_ax::allow_fullscreen(ns, allowed);
        }
    });
}

/// 마우스가 구멍 위면 마인드맵이 클릭을 흘려보내게 (클로드 창이 받음)
fn watch_cursor(win: Window, gen: u64) {
    std::thread::spawn(move || {
        let mut ignoring = false;
        loop {
            std::thread::sleep(Duration::from_millis(40));
            let hole = match DOCK.lock().unwrap().as_ref() {
                Some(d) if d.gen == gen => d.hole,
                _ => break,
            };
            let inside = (|| {
                let k = win.scale_factor().ok()?;
                let c = win.cursor_position().ok()?;
                let (ox, oy) = origin(&win)?;
                let (cx, cy) = (c.x / k - ox, c.y / k - oy);
                Some(cx >= hole.x && cx < hole.x + hole.w && cy >= hole.y && cy < hole.y + hole.h)
            })()
            .unwrap_or(false);
            if inside != ignoring {
                ignoring = inside;
                let _ = win.set_ignore_cursor_events(inside);
            }
        }
        let _ = win.set_ignore_cursor_events(false);
    });
}

/// 붙이기 기록: 무엇이 왜 안 됐는지 나중에 볼 수 있게 (~/.claude-mindmap/dock.log, 200줄까지)
fn log(line: &str) {
    use std::io::Write;
    let p = crate::app_dir::settings_file("dock.log");
    let old = std::fs::read_to_string(&p).unwrap_or_default();
    let keep: Vec<&str> = old.lines().rev().take(199).collect::<Vec<_>>().into_iter().rev().collect();
    if let Ok(mut f) = std::fs::File::create(&p) {
        for l in keep {
            let _ = writeln!(f, "{l}");
        }
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let _ = writeln!(f, "{t} {line}");
    }
}

/// 화면 버튼: on = 붙이기(hole 자리에), off = 떼기. 답의 width·height = 클로드 창 실제 크기
#[tauri::command]
pub fn claude_dock(window: WebviewWindow, on: bool, hole: Option<Hole>) -> Result<Value, String> {
    let r = dock(window, on, hole);
    match &r {
        Ok(v) => log(&format!("ok on={on} hole={hole:?} {v}")),
        Err(e) => log(&format!("err on={on} hole={hole:?} {e}")),
    }
    r
}

fn dock(window: WebviewWindow, on: bool, hole: Option<Hole>) -> Result<Value, String> {
    let win = window.as_ref().window();
    if !on {
        *DOCK.lock().unwrap() = None;
        let _ = win.set_ignore_cursor_events(false);
        set_fullscreen_allowed(&win, true);
        return Ok(json!({ "ok": true, "on": false }));
    }
    let hole = hole.ok_or("구멍 자리가 없어요")?;
    if !claude_app_ax::ask_permission() {
        return Err("마인드맵에 손쉬운 사용 권한이 필요해요. 맥이 띄운 창에서 허용한 뒤 다시 눌러 주세요".into());
    }
    let (w, h) = place(&win, hole).ok_or("클로드 앱 창을 못 찾았어요. 클로드 앱이 켜져 있어야 해요")?;
    claude_app_ax::raise_window();
    let mut st = DOCK.lock().unwrap();
    let start = st.is_none();
    let gen = if start {
        let mut g = GEN.lock().unwrap();
        *g += 1;
        *g
    } else {
        st.as_ref().map(|d| d.gen).unwrap_or(0)
    };
    *st = Some(Dock { hole, gen });
    drop(st);
    if start {
        set_fullscreen_allowed(&win, false);
        watch_cursor(win, gen);
    }
    Ok(json!({ "ok": true, "on": true, "width": w, "height": h }))
}

/// 창 이벤트: 붙인 동안 옮기기·크기 바꾸기를 따라가고, 마인드맵을 누르면 클로드 창도 위로
pub fn on_window_event(win: &Window, ev: &tauri::WindowEvent) {
    let hole = match DOCK.lock().unwrap().as_ref() {
        Some(d) => d.hole,
        None => return,
    };
    match ev {
        tauri::WindowEvent::Moved(_) => {
            place(win, hole);
        }
        tauri::WindowEvent::Focused(true) => {
            place(win, hole);
            claude_app_ax::raise_window();
        }
        // 크기가 바뀌면 화면(JS)이 새 구멍 자리를 다시 보낸다
        _ => {}
    }
}
