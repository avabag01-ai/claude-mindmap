//! 클로드 데스크톱 앱 코드 탭의 사이드바 구조를 읽는다. JS 쪽은 src/core/ClaudeApp.js.
//! 새로 만든 세션은 앱의 가져오기 링크로 넣는다 (import_session) — 파일은 직접 쓰지 않는다
//! - 세션 기록: ~/Library/Application Support/Claude/claude-code-sessions/<계정>/<조직>/local_*.json
//!   (cliSessionId = ~/.claude/projects 의 세션 id, title, isArchived, createdAt)
//! - 그룹: claude_desktop_config.json → preferences.epitaxyPrefs
//!   dframe-code-sections(순서·이름) · dframe-group-scopes(assignments: "code:local_…" → 그룹 id) · starred-local-code-sessions(고정)
//! 돌려주는 모양: { ok, groups: [{ id, name }], sessions: { <cliSessionId>: { appId, title, group, archived, createdAt, pinned } } }

use crate::app_dir;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

pub fn app_dir_path() -> PathBuf {
    match std::env::var("MINDMAP_CLAUDE_APP_DIR") {
        Ok(d) if !d.is_empty() => PathBuf::from(d),
        _ => app_dir::home().join("Library").join("Application Support").join("Claude"),
    }
}

pub fn read() -> Value {
    read_from(&app_dir_path())
}

fn read_json(p: &Path) -> Option<Value> {
    fs::read_to_string(p).ok().and_then(|t| serde_json::from_str(&t).ok())
}

pub fn read_from(dir: &Path) -> Value {
    let prefs = read_json(&dir.join("claude_desktop_config.json")).map(|c| c["preferences"]["epitaxyPrefs"].clone()).unwrap_or(Value::Null);
    let sections = prefs["dframe-code-sections"].as_object().cloned().unwrap_or_default();
    let scopes = prefs["dframe-group-scopes"].as_object().cloned().unwrap_or_default();
    // 계정/조직 범위: 섹션이 있는 첫 범위 (없으면 기록 폴더의 첫 범위)
    let scope = sections.keys().next().or_else(|| scopes.keys().next()).cloned().or_else(|| first_scope(&dir.join("claude-code-sessions")));
    let Some(scope) = scope else {
        return json!({ "ok": false, "groups": [], "sessions": {} });
    };

    let mut groups: Vec<(f64, String, String)> = sections
        .get(&scope)
        .and_then(|s| s["sections"].as_array())
        .into_iter()
        .flatten()
        .filter(|s| s["kind"] == "manual")
        .map(|s| (s["order"].as_f64().unwrap_or(0.0), s["id"].as_str().unwrap_or("").to_string(), s["name"].as_str().unwrap_or("").to_string()))
        .collect();
    // 섹션에 없고 그룹 목록에만 있는 것도 (뒤에)
    for g in scopes.get(&scope).and_then(|s| s["groups"].as_array()).into_iter().flatten() {
        let id = g["id"].as_str().unwrap_or("").to_string();
        if !id.is_empty() && !groups.iter().any(|x| x.1 == id) {
            groups.push((f64::MAX, id, g["name"].as_str().unwrap_or("").to_string()));
        }
    }
    groups.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let assignments = scopes.get(&scope).and_then(|s| s["assignments"].as_object()).cloned().unwrap_or_default();
    let pinned: Vec<String> = prefs["starred-local-code-sessions"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_string)).collect();

    let mut sessions = Map::new();
    let rec_dir = dir.join("claude-code-sessions").join(&scope);
    for e in fs::read_dir(&rec_dir).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.starts_with("local_") || !name.ends_with(".json") {
            continue;
        }
        let Some(r) = read_json(&e.path()) else { continue };
        let (Some(app_id), Some(cli)) = (r["sessionId"].as_str(), r["cliSessionId"].as_str()) else { continue };
        let group = assignments.get(&format!("code:{app_id}")).cloned().unwrap_or(Value::Null);
        let is_pinned = pinned.iter().any(|p| p == app_id || p.ends_with(app_id));
        sessions.insert(
            cli.to_string(),
            json!({ "appId": app_id, "title": r["title"], "group": group, "archived": r["isArchived"].as_bool().unwrap_or(false), "createdAt": r["createdAt"], "pinned": is_pinned }),
        );
    }
    json!({
        "ok": true,
        "groups": groups.into_iter().map(|(_, id, name)| json!({ "id": id, "name": name })).collect::<Vec<_>>(),
        "sessions": sessions,
    })
}

/// 클로드 앱에 이 세션을 알린다: claude://resume 링크(클로드 앱이 터미널 세션을 들여오는 길)를 뒤에서(open -g) 연다.
/// 켜져 있으면 바로 사이드바에 생기고, 이미 있으면 그 세션으로 넘어간다. 앱을 다시 켤 필요가 없다.
pub fn show_in_app(cli_id: &str) -> bool {
    if cli_id.is_empty() || !cli_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return false;
    }
    std::process::Command::new("open").args(["-g", &format!("claude://resume?session={cli_id}")]).status().map_or(false, |s| s.success())
}

/// (예비) 클로드 앱이 꺼져 있을 때 쓰는 길: 기록 파일을 직접 넣는다. 지금은 show_in_app 을 쓴다.
/// 마인드맵에서 새로 만든 세션을 클로드 앱에 넣는다: 앱의 가져오기 링크(claude://resume)를 뒤에서 연다.
/// 켜져 있는 앱이 바로 사이드바에 넣고 자기 기록(local_*.json)도 만든다. 앱이 꺼져 있으면 켜면서 가져온다.
pub fn import_session(cli_id: &str) -> bool {
    if cli_id.is_empty() || !cli_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return false;
    }
    std::process::Command::new("open").args(["-g", &format!("claude://resume?session={cli_id}")]).status().map_or(false, |s| s.success())
}

/// 제목: 첫 메시지에서 내용을 알 수 있는 부분, max 자까지.
/// 마인드맵이 띄운 "툰 불러와 — 하위 세션, root: …, hub_task: NEXT 000005 할 일" 은 다 같아 보이니 할 일만 쓴다.
pub fn title_from(text: &str, max: usize) -> String {
    let body = match text.find("hub_task:") {
        Some(i) => {
            let t = text[i + "hub_task:".len()..].trim_start();
            // 앞의 "NEXT 000005" 번호는 뺀다
            let t = t.strip_prefix("NEXT").map(|r| r.trim_start().trim_start_matches(|c: char| c.is_ascii_digit())).unwrap_or(t);
            t
        }
        None => text,
    };
    let line = body.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let mut t: String = line.chars().take(max).collect();
    if line.chars().count() > max {
        t.push('…');
    }
    t
}

fn first_scope(base: &Path) -> Option<String> {
    let acct = fs::read_dir(base).ok()?.flatten().find(|e| e.path().is_dir())?;
    let org = fs::read_dir(acct.path()).ok()?.flatten().find(|e| e.path().is_dir())?;
    Some(format!("{}/{}", acct.file_name().to_string_lossy(), org.file_name().to_string_lossy()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_groups_and_sessions() {
        let d = std::env::temp_dir().join(format!("mm-claude-app-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        let rec = d.join("claude-code-sessions/acct/org");
        fs::create_dir_all(&rec).unwrap();
        fs::write(
            d.join("claude_desktop_config.json"),
            json!({ "preferences": { "epitaxyPrefs": {
                "dframe-code-sections": { "acct/org": { "sections": [
                    { "id": "pinned", "kind": "pinned", "order": 0 },
                    { "id": "g2", "kind": "manual", "name": "작곡", "order": 3 },
                    { "id": "g1", "kind": "manual", "name": "valveforge", "order": 2 },
                    { "id": "sessions", "kind": "sessions", "order": 5 } ] } },
                "dframe-group-scopes": { "acct/org": { "groups": [{ "id": "g1", "name": "valveforge" }, { "id": "g2", "name": "작곡" }],
                    "assignments": { "code:local_a": "g1" } } },
                "starred-local-code-sessions": ["code:local_b"] } } })
            .to_string(),
        )
        .unwrap();
        fs::write(rec.join("local_a.json"), json!({ "sessionId": "local_a", "cliSessionId": "cli-a", "title": "가", "createdAt": 1, "isArchived": false }).to_string()).unwrap();
        fs::write(rec.join("local_b.json"), json!({ "sessionId": "local_b", "cliSessionId": "cli-b", "title": "나", "createdAt": 2, "isArchived": true }).to_string()).unwrap();
        fs::write(rec.join("local_c.json"), "깨진 파일").unwrap();
        let v = read_from(&d);
        assert_eq!(v["ok"], true);
        assert_eq!(v["groups"], json!([{ "id": "g1", "name": "valveforge" }, { "id": "g2", "name": "작곡" }]));
        assert_eq!(v["sessions"]["cli-a"]["group"], "g1");
        assert_eq!(v["sessions"]["cli-a"]["title"], "가");
        assert_eq!(v["sessions"]["cli-b"]["archived"], true);
        assert_eq!(v["sessions"]["cli-b"]["pinned"], true);
        assert_eq!(v["sessions"]["cli-b"]["group"], Value::Null);
        assert_eq!(read_from(&d.join("없음"))["ok"], false);
    }

    #[test]
    fn titles_and_import_guard() {
        assert_eq!(title_from("\n  첫 줄\n둘째", 40), "첫 줄");
        assert_eq!(title_from("툰 불러와 — 하위 세션, root: ~/a, topic: b, hub_task: NEXT 000005 클로드 앱 자동 등록\n둘째", 40), "클로드 앱 자동 등록");
        assert_eq!(title_from("툰 불러와 logic-pro-mcp", 40), "툰 불러와 logic-pro-mcp");
        assert_eq!(title_from(&"가".repeat(45), 40).chars().count(), 41);
        assert!(!import_session("x; rm -rf"), "id 가 아니면 열지 않음");
    }
}
