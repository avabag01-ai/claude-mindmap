//! 가운데 GitHub·브라우저 탭: 메인 창 안에 진짜 웹 화면(맥 WebKit = 사파리 엔진)을 띄우는 자식 웹뷰.
//! 화면(src/modules/HubCenterWeb.js)이 자리(.cw-slot)의 좌표를 보내면 그 자리에 맞춰 보이고, 다른 탭이면 숨긴다.
//! - 라벨은 "github"(GitHub 탭)·"web"(브라우저 탭) 둘뿐. 로그인은 사용자가 이 안에서 직접 한다 (쿠키는 웹뷰 저장소에 남음).
//! - 원격 주소라 이 웹뷰에는 앱 IPC 권한이 없다 (capabilities 는 앱 화면에만).
//! - 새 창으로 여는 링크(target=_blank)는 같은 웹뷰에서 연다.
//! Window::add_child 는 tauri 의 "unstable" 기능. 메인 스레드를 기다리므로 명령은 async 로 둔다(동기 명령이면 멈춤).

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Url, WebviewBuilder, WebviewUrl};

const LABELS: [&str; 2] = ["github", "web"];

fn check(label: &str) -> Result<(), String> {
    if LABELS.contains(&label) { Ok(()) } else { Err(format!("모르는 웹 화면: {label}")) }
}

/// https·http 만. 주소가 아니면 None
pub fn parse_url(s: &str) -> Option<Url> {
    let u = Url::parse(s.trim()).ok()?;
    matches!(u.scheme(), "https" | "http").then_some(u)
}

fn home(label: &str) -> Url {
    Url::parse(if label == "github" { "https://github.com/" } else { "https://www.google.com/" }).unwrap()
}

fn current(app: &AppHandle, label: &str) -> String {
    app.get_webview(label).and_then(|v| v.url().ok()).map(|u| u.to_string()).unwrap_or_default()
}

/// 자리에 맞춰 보이기 (없으면 만든다). url 을 주면 그 주소로 간다. 답: 지금 주소
#[tauri::command]
pub async fn web_show(app: AppHandle, label: String, x: f64, y: f64, w: f64, h: f64, url: Option<String>) -> Result<String, String> {
    check(&label)?;
    let pos = LogicalPosition::new(x, y);
    let size = LogicalSize::new(w.max(1.0), h.max(1.0));
    let go = url.as_deref().and_then(parse_url);
    if let Some(v) = app.get_webview(&label) {
        v.set_position(pos).map_err(|e| e.to_string())?;
        v.set_size(size).map_err(|e| e.to_string())?;
        v.show().map_err(|e| e.to_string())?;
        if let Some(u) = go { v.navigate(u).map_err(|e| e.to_string())?; }
        return Ok(current(&app, &label));
    }
    let win = app.get_window("main").ok_or("메인 창이 없어요")?;
    let start = go.unwrap_or_else(|| home(&label));
    let (app2, label2) = (app.clone(), label.clone());
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(start)).on_new_window(move |u, _| {
        if let Some(v) = app2.get_webview(&label2) { let _ = v.navigate(u); }
        NewWindowResponse::Deny
    });
    win.add_child(builder, pos, size).map_err(|e| e.to_string())?;
    Ok(current(&app, &label))
}

#[tauri::command]
pub async fn web_hide(app: AppHandle, label: String) -> Result<(), String> {
    check(&label)?;
    if let Some(v) = app.get_webview(&label) { v.hide().map_err(|e| e.to_string())?; }
    Ok(())
}

/// back · forward · reload · home. 답: 지금 주소
#[tauri::command]
pub async fn web_go(app: AppHandle, label: String, action: String) -> Result<String, String> {
    check(&label)?;
    let v = app.get_webview(&label).ok_or("웹 화면이 아직 없어요")?;
    match action.as_str() {
        "back" => v.eval("history.back()"),
        "forward" => v.eval("history.forward()"),
        "reload" => v.reload(),
        "home" => v.navigate(home(&label)),
        _ => return Err(format!("모르는 동작: {action}")),
    }
    .map_err(|e| e.to_string())?;
    Ok(current(&app, &label))
}

#[tauri::command]
pub async fn web_url(app: AppHandle, label: String) -> Result<String, String> {
    check(&label)?;
    Ok(current(&app, &label))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_urls() {
        assert!(parse_url("https://github.com/avabag01-ai").is_some());
        assert!(parse_url(" http://localhost:3000 ").is_some());
        assert!(parse_url("file:///etc/passwd").is_none());
        assert!(parse_url("javascript:alert(1)").is_none());
        assert!(parse_url("github.com").is_none());
    }

    #[test]
    fn labels() {
        assert!(check("github").is_ok());
        assert!(check("web").is_ok());
        assert!(check("main").is_err());
    }
}
