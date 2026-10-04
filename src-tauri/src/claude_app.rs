//! 클로드 데스크톱 앱 코드 탭의 사이드바 구조를 읽기만 한다 (쓰지 않음). JS 쪽은 src/core/ClaudeApp.js.
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
}
