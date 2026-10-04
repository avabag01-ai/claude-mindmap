//! 가운데 브라우저 탭의 "기록·즐겨찾기": 맥 크롬의 즐겨찾기(Bookmarks JSON)와 방문 기록(History SQLite)을 읽기만 한다.
//! - 프로필 = Local State 의 마지막 프로필, 없으면 Default.
//! - 기록 파일은 크롬이 켜져 있으면 잠겨 있어서 임시 폴더로 복사한 뒤 맥 기본 sqlite3 로 읽는다(-json, 읽기 전용).
//! - 크롬 쪽은 아무것도 바꾸지 않는다. 화면은 src/modules/HubCenterWeb.js.

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Serialize, Debug, PartialEq)]
pub struct Place {
    pub title: String,
    pub url: String,
    /// 즐겨찾기: 폴더 이름(“북마크바 > 개발”), 기록: 방문 횟수
    pub note: String,
    /// 기록: 마지막 방문(유닉스 ms), 즐겨찾기: 0
    pub at: f64,
}

#[derive(Serialize)]
pub struct Places {
    pub profile: String,
    pub bookmarks: Vec<Place>,
    pub history: Vec<Place>,
}

const HISTORY_LIMIT: usize = 500;
// 크롬 시간(1601-01-01 부터 마이크로초) → 유닉스 ms
const CHROME_EPOCH_MS: f64 = 11_644_473_600_000.0;

fn chrome_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join("Library/Application Support/Google/Chrome")
}

fn profile_dir(base: &Path) -> (String, PathBuf) {
    let last = std::fs::read_to_string(base.join("Local State"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.pointer("/profile/last_used").and_then(|x| x.as_str()).map(|s| s.to_string()))
        .filter(|p| !p.contains('/') && !p.contains(".."));
    let name = last.filter(|p| base.join(p).is_dir()).unwrap_or_else(|| "Default".into());
    let dir = base.join(&name);
    (name, dir)
}

fn web_url(u: &str) -> bool {
    u.starts_with("https://") || u.starts_with("http://")
}

/// Bookmarks JSON → 평평한 목록 (폴더 경로를 note 에)
pub fn parse_bookmarks(text: &str) -> Vec<Place> {
    fn walk(v: &Value, path: &str, out: &mut Vec<Place>) {
        match v.get("type").and_then(|t| t.as_str()) {
            Some("url") => {
                let url = v.get("url").and_then(|u| u.as_str()).unwrap_or("");
                if web_url(url) {
                    let title = v.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                    out.push(Place { title, url: url.to_string(), note: path.to_string(), at: 0.0 });
                }
            }
            Some("folder") => {
                let name = v.get("name").and_then(|n| n.as_str()).unwrap_or("");
                let sub = if path.is_empty() { name.to_string() } else { format!("{path} > {name}") };
                for c in v.get("children").and_then(|c| c.as_array()).into_iter().flatten() {
                    walk(c, &sub, out);
                }
            }
            _ => {}
        }
    }
    let mut out = Vec::new();
    let Ok(d) = serde_json::from_str::<Value>(text) else { return out };
    if let Some(roots) = d.get("roots").and_then(|r| r.as_object()) {
        for key in ["bookmark_bar", "other", "synced"] {
            if let Some(r) = roots.get(key) {
                walk(r, "", &mut out);
            }
        }
    }
    out
}

/// sqlite3 -json 결과 → 기록 목록
pub fn parse_history(json: &str) -> Vec<Place> {
    let rows: Vec<Value> = serde_json::from_str(json.trim()).unwrap_or_default();
    rows.iter()
        .filter_map(|r| {
            let url = r.get("url")?.as_str()?;
            if !web_url(url) {
                return None;
            }
            let t = r.get("last_visit_time").and_then(|x| x.as_f64()).unwrap_or(0.0);
            Some(Place {
                title: r.get("title").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                url: url.to_string(),
                note: format!("{}번", r.get("visit_count").and_then(|x| x.as_i64()).unwrap_or(0)),
                at: if t > 0.0 { t / 1000.0 - CHROME_EPOCH_MS } else { 0.0 },
            })
        })
        .collect()
}

fn read_history(profile: &Path) -> Result<Vec<Place>, String> {
    let src = profile.join("History");
    if !src.exists() {
        return Ok(vec![]);
    }
    let tmp = std::env::temp_dir().join(format!("claude-mindmap-chrome-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let db = tmp.join("History");
    std::fs::copy(&src, &db).map_err(|e| format!("크롬 기록을 복사하지 못했어요: {e}"))?;
    let q = format!(
        "SELECT url, title, visit_count, last_visit_time FROM urls WHERE hidden = 0 ORDER BY last_visit_time DESC LIMIT {HISTORY_LIMIT};"
    );
    let out = Command::new("/usr/bin/sqlite3")
        .arg("-readonly")
        .arg("-json")
        .arg(&db)
        .arg(q)
        .output()
        .map_err(|e| format!("sqlite3 를 못 돌렸어요: {e}"));
    let _ = std::fs::remove_dir_all(&tmp); // 복사본은 바로 지운다
    let out = out?;
    if !out.status.success() {
        return Err(format!("크롬 기록을 못 읽었어요: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(parse_history(&String::from_utf8_lossy(&out.stdout)))
}

pub fn load() -> Result<Places, String> {
    let base = chrome_dir();
    if !base.is_dir() {
        return Err("이 맥에 크롬이 없어요".into());
    }
    let (profile, dir) = profile_dir(&base);
    let bookmarks = std::fs::read_to_string(dir.join("Bookmarks")).map(|t| parse_bookmarks(&t)).unwrap_or_default();
    let history = read_history(&dir)?;
    Ok(Places { profile, bookmarks, history })
}

#[tauri::command]
pub async fn chrome_places() -> Result<Places, String> {
    tauri::async_runtime::spawn_blocking(load).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bookmarks_flatten_with_folders() {
        let t = r#"{"roots":{"bookmark_bar":{"type":"folder","name":"북마크바","children":[
            {"type":"url","name":"깃허브","url":"https://github.com/"},
            {"type":"folder","name":"개발","children":[{"type":"url","name":"러스트","url":"https://www.rust-lang.org/"}]},
            {"type":"url","name":"스크립트","url":"javascript:alert(1)"}]},
            "other":{"type":"folder","name":"기타","children":[]}}}"#;
        let b = parse_bookmarks(t);
        assert_eq!(b.len(), 2);
        assert_eq!(b[0].title, "깃허브");
        assert_eq!(b[0].note, "북마크바");
        assert_eq!(b[1].note, "북마크바 > 개발");
        assert!(parse_bookmarks("not json").is_empty());
    }

    #[test]
    fn history_rows_and_time() {
        let j = r#"[{"url":"https://a.com/","title":"A","visit_count":3,"last_visit_time":13405000000000000},
                    {"url":"chrome://settings","title":"설정","visit_count":1,"last_visit_time":1}]"#;
        let h = parse_history(j);
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].note, "3번");
        // 13405000000000000 µs(1601) → 2025-10 쯤 유닉스 ms
        assert!(h[0].at > 1.7e12 && h[0].at < 1.9e12);
        assert!(parse_history("").is_empty());
    }

    #[test]
    #[ignore]
    fn live_load() {
        let p = load().unwrap();
        println!("{} 즐겨찾기 {} 기록 {}", p.profile, p.bookmarks.len(), p.history.len());
        assert!(!p.bookmarks.is_empty() || !p.history.is_empty());
    }
}
