//! 클로드 데스크톱 앱 코드 탭의 사이드바 구조를 읽는다. JS 쪽은 src/core/ClaudeApp.js.
//! 새로 만든 세션은 앱의 가져오기 링크로 넣는다 (import_session) — 파일은 직접 쓰지 않는다
//! - 세션 기록: ~/Library/Application Support/Claude/claude-code-sessions/<계정>/<조직>/local_*.json
//!   (cliSessionId = ~/.claude/projects 의 세션 id, title, isArchived, createdAt)
//! - 그룹: claude_desktop_config.json → preferences.epitaxyPrefs
//!   dframe-code-sections(순서·이름) · dframe-group-scopes(assignments: "code:local_…" → 그룹 id) · starred-local-code-sessions(고정)
//! 돌려주는 모양: { ok, groups: [{ id, name }], sessions: { <cliSessionId>: { appId, title, group, archived, createdAt, pinned, adopted } } }

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
            json!({ "appId": app_id, "title": r["title"], "group": group, "archived": r["isArchived"].as_bool().unwrap_or(false), "createdAt": r["createdAt"], "pinned": is_pinned, "adopted": r["adoptedFromOtherSurface"].as_bool().unwrap_or(false) }),
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

/// 클로드 앱 안에서 새 코드 세션을 연다: claude://code/new?folder=…&q=… (폴더와 첫 메시지를 채워 둘 뿐, 보내기는 사람이)
/// 앱 안 세션이라 그룹 넣기 도구(ccd_sidebar move_sessions)를 쓸 수 있다. 앞으로 띄워서 바로 Enter 를 누르게 한다.
pub fn new_session_url(folder: &str, prompt: &str) -> String {
    let enc = |t: &str| -> String {
        t.bytes()
            .map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
            .collect()
    };
    let q: String = prompt.chars().take(14000).collect();
    format!("claude://code/new?folder={}&q={}", enc(folder), enc(&q))
}

pub fn new_in_app(folder: &str, prompt: &str) -> bool {
    if folder.is_empty() || !Path::new(folder).is_dir() {
        return false;
    }
    std::process::Command::new("open").arg(new_session_url(folder, prompt)).status().map_or(false, |s| s.success())
}

/// 앱 세션 기록(local_<id>.json)의 지금 제목. 앱이 제목을 바꾸면 여기도 바뀐다
pub fn app_title(app_id: &str) -> Option<String> {
    app_title_in(&app_dir_path(), app_id)
}

pub fn app_title_in(dir: &Path, app_id: &str) -> Option<String> {
    if !crate::claude_app_ax::valid_app_id(app_id) {
        return None;
    }
    let base = dir.join("claude-code-sessions");
    for acct in fs::read_dir(&base).ok()?.flatten() {
        for org in fs::read_dir(acct.path()).into_iter().flatten().flatten() {
            if let Some(r) = read_json(&org.path().join(format!("{app_id}.json"))) {
                return r["title"].as_str().map(str::to_string);
            }
        }
    }
    None
}

/// (보내기를 못 할 때) 클로드 앱 세션에 보낼 글: 글을 클립보드에 넣고 그 세션을 앱 앞으로 연다 (붙여넣고 Enter 는 사람이).
/// 마인드맵이 claude --resume 으로 따로 돌리면 앱 화면과 앱 세션은 그 대화를 모른다.
/// app_id 가 있으면 앱 세션으로 바로 가는 링크(code/continue), 없으면 가져오기 링크(resume)
pub fn hand_off(cli_id: &str, app_id: &str, text: &str) -> bool {
    let url = if crate::claude_app_ax::valid_app_id(app_id) {
        crate::claude_app_ax::continue_url(app_id)
    } else if !cli_id.is_empty() && cli_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        format!("claude://resume?session={cli_id}")
    } else {
        return false;
    };
    use std::io::Write;
    let copied = std::process::Command::new("pbcopy")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut c| {
            c.stdin.take().map(|mut i| i.write_all(text.as_bytes())).transpose()?;
            c.wait()
        })
        .map_or(false, |s| s.success());
    let opened = std::process::Command::new("open").arg(url).status().map_or(false, |s| s.success());
    copied && opened
}

/// 툰 이어가기: 앱 세션 기록(jsonl)의 offset 바이트 뒤에 쓰인 답에서 ```toon-next 블록이 닫힐 때까지 기다린다.
/// 찾으면 그 답 글 전부 (시작 메시지 뽑기는 화면의 SessionHub.nextPrompt). limit 이 지나면 None
pub fn wait_toon_next(file: &Path, offset: u64, limit: std::time::Duration) -> Option<String> {
    let re = regex::Regex::new(r"```toon-next[^\n]*\n[\s\S]*?```").ok()?;
    let t0 = std::time::Instant::now();
    loop {
        if let Some(text) = assistant_text_after(file, offset) {
            if re.is_match(&text) {
                return Some(text);
            }
        }
        if t0.elapsed() >= limit {
            return None;
        }
        std::thread::sleep(std::time::Duration::from_secs(2));
    }
}

/// offset 바이트 뒤 줄들 중 클로드 답(assistant)의 글만 이어 붙인다
pub fn assistant_text_after(file: &Path, offset: u64) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = fs::File::open(file).ok()?;
    f.seek(SeekFrom::Start(offset)).ok()?;
    let mut buf = String::new();
    f.read_to_string(&mut buf).ok()?;
    let mut out = Vec::new();
    for line in buf.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v["type"] != "assistant" {
            continue;
        }
        for b in v["message"]["content"].as_array().into_iter().flatten() {
            if b["type"] == "text" {
                if let Some(t) = b["text"].as_str() {
                    out.push(t.to_string());
                }
            }
        }
    }
    Some(out.join("\n\n"))
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
    fn new_session_link() {
        assert_eq!(new_session_url("/Users/kim/a b", "툰 — x&y"), "claude://code/new?folder=%2FUsers%2Fkim%2Fa%20b&q=%ED%88%B0%20%E2%80%94%20x%26y");
        assert!(!new_in_app("/없는/폴더", "x"));
    }

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
        assert_eq!(v["sessions"]["cli-b"]["adopted"], false, "들여온 표시가 없으면 앱에서 만든 세션");
        assert_eq!(v["sessions"]["cli-b"]["group"], Value::Null);
        assert_eq!(read_from(&d.join("없음"))["ok"], false);
        assert_eq!(app_title_in(&d, "local_a").as_deref(), Some("가"));
        assert_eq!(app_title_in(&d, "local_zz"), None);
        assert_eq!(app_title_in(&d, "../x"), None, "id 가 아니면 읽지 않음");
    }

    #[test]
    fn titles_and_import_guard() {
        assert_eq!(title_from("\n  첫 줄\n둘째", 40), "첫 줄");
        assert_eq!(title_from("툰 불러와 — 하위 세션, root: ~/a, topic: b, hub_task: NEXT 000005 클로드 앱 자동 등록\n둘째", 40), "클로드 앱 자동 등록");
        assert_eq!(title_from("툰 불러와 logic-pro-mcp", 40), "툰 불러와 logic-pro-mcp");
        assert_eq!(title_from(&"가".repeat(45), 40).chars().count(), 41);
        assert!(!import_session("x; rm -rf"), "id 가 아니면 열지 않음");
    }

    #[test]
    fn toon_next_after_offset() {
        let d = std::env::temp_dir().join(format!("mm-toon-next-{}.jsonl", std::process::id()));
        let line = |t: &str| json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": t }] } }).to_string() + "\n";
        let old = line("예전 답\n```toon-next\n예전 — 툰 불러와\n```");
        fs::write(&d, &old).unwrap();
        let off = old.len() as u64;
        let mut all = old.clone();
        all += &json!({ "type": "user", "message": { "content": "툰 저장해줘" } }).to_string();
        all += "\n";
        all += &line("저장했어요\n```toon-next\n새 제목 — 툰 불러와 — root: /a\n```");
        fs::write(&d, &all).unwrap();
        let t = wait_toon_next(&d, off, std::time::Duration::from_millis(10)).unwrap();
        assert!(t.contains("새 제목") && !t.contains("예전"), "offset 앞의 예전 답은 안 봄");
        fs::write(&d, &old).unwrap();
        assert_eq!(wait_toon_next(&d, off, std::time::Duration::from_millis(10)), None);
        let _ = fs::remove_file(&d);
    }
}
