//! 허용 묻기: scripts/mindmap-approve-mcp.js 가 ~/.claude-mindmap/approvals/<id>.req.json 에 물음을 쓰면
//! 화면이 'approval:list' 로 읽어 허용 / 거절 창을 띄우고, 'approval:answer' 로 <id>.ans.json 을 쓴다.
//! "이 폴더에서 항상 허용" 은 클로드 앱·터미널 claude 와 같은 자리(<폴더>/.claude/settings.local.json)에 규칙으로 남긴다.

use crate::app_dir;
use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

const STALE_MS: f64 = 11.0 * 60.0 * 1000.0; // 묻는 쪽은 10분 기다림

pub fn dir() -> PathBuf {
    app_dir::settings_file("approvals")
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// 아직 답하지 않은 물음 (오래된 순)
pub fn list_in(dir: &Path) -> Vec<Value> {
    let mut out: Vec<Value> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".req.json"))
        .filter_map(|e| fs::read_to_string(e.path()).ok())
        .filter_map(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(|v| now_ms() - v["at"].as_f64().unwrap_or(0.0) < STALE_MS)
        .filter(|v| v["id"].as_str().map(|id| !dir.join(format!("{id}.ans.json")).exists()).unwrap_or(false))
        .map(|mut v| {
            let rule = rule_for(v["tool"].as_str().unwrap_or(""), &v["input"]);
            v["rule"] = json!(rule);
            v
        })
        .collect();
    out.sort_by(|a, b| a["at"].as_f64().partial_cmp(&b["at"].as_f64()).unwrap_or(std::cmp::Ordering::Equal));
    out
}

/// 항상 허용 규칙: Bash 는 그 명령 그대로, 나머지는 도구 이름
pub fn rule_for(tool: &str, input: &Value) -> String {
    match (tool, input["command"].as_str()) {
        ("Bash", Some(cmd)) => format!("Bash({cmd})"),
        _ => tool.to_string(),
    }
}

pub fn answer_in(dir: &Path, id: &str, allow: bool, always: bool) -> Result<Value> {
    if !valid_id(id) {
        bail!("물음 번호가 올바르지 않아요");
    }
    let req_file = dir.join(format!("{id}.req.json"));
    let req: Value = match fs::read_to_string(&req_file).ok().and_then(|t| serde_json::from_str(&t).ok()) {
        Some(v) => v,
        None => bail!("이미 끝난 물음이에요"),
    };
    let mut rule = Value::Null;
    if allow && always {
        let r = rule_for(req["tool"].as_str().unwrap_or(""), &req["input"]);
        if let Some(cwd) = req["cwd"].as_str().filter(|c| !c.is_empty()) {
            add_rule(Path::new(cwd), &r)?;
            rule = json!(r);
        }
    }
    let ans = dir.join(format!("{id}.ans.json"));
    let tmp = dir.join(format!("{id}.ans.json.tmp"));
    let body = if allow { json!({ "allow": true }) } else { json!({ "allow": false, "message": "사용자가 마인드맵에서 거절했어요" }) };
    fs::write(&tmp, body.to_string())?;
    fs::rename(&tmp, &ans)?;
    Ok(json!({ "id": id, "allow": allow, "rule": rule }))
}

/// <폴더>/.claude/settings.local.json 의 permissions.allow 에 규칙을 더한다 (이미 있으면 그대로)
pub fn add_rule(cwd: &Path, rule: &str) -> Result<()> {
    let file = cwd.join(".claude").join("settings.local.json");
    let mut v: Value = fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| json!({}));
    if !v.is_object() {
        bail!("{} 가 JSON 객체가 아니에요", file.display());
    }
    if !v["permissions"].is_object() {
        v["permissions"] = json!({});
    }
    if !v["permissions"]["allow"].is_array() {
        v["permissions"]["allow"] = json!([]);
    }
    let allow = v["permissions"]["allow"].as_array_mut().unwrap();
    if !allow.iter().any(|x| x.as_str() == Some(rule)) {
        allow.push(json!(rule));
    }
    fs::create_dir_all(file.parent().unwrap())?;
    fs::write(&file, serde_json::to_string_pretty(&v)? + "\n")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mm-approve-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn list_answer_and_always() {
        let d = tmp("a");
        let cwd = tmp("cwd");
        let id = "0a1b-2c3d";
        fs::write(d.join(format!("{id}.req.json")), json!({ "id": id, "tool": "Bash", "input": { "command": "npm test" }, "cwd": cwd, "at": now_ms() }).to_string()).unwrap();
        let l = list_in(&d);
        assert_eq!(l.len(), 1);
        assert_eq!(l[0]["rule"], "Bash(npm test)");
        let r = answer_in(&d, id, true, true).unwrap();
        assert_eq!(r["rule"], "Bash(npm test)");
        let ans: Value = serde_json::from_str(&fs::read_to_string(d.join(format!("{id}.ans.json"))).unwrap()).unwrap();
        assert_eq!(ans["allow"], true);
        assert!(list_in(&d).is_empty(), "답한 물음은 목록에서 빠진다");
        let s: Value = serde_json::from_str(&fs::read_to_string(cwd.join(".claude/settings.local.json")).unwrap()).unwrap();
        assert_eq!(s["permissions"]["allow"], json!(["Bash(npm test)"]));
        // 두 번 더해도 하나
        add_rule(&cwd, "Bash(npm test)").unwrap();
        let s: Value = serde_json::from_str(&fs::read_to_string(cwd.join(".claude/settings.local.json")).unwrap()).unwrap();
        assert_eq!(s["permissions"]["allow"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn bad_id_and_deny() {
        let d = tmp("b");
        assert!(answer_in(&d, "../x", true, false).is_err());
        fs::write(d.join("ff.req.json"), json!({ "id": "ff", "tool": "WebFetch", "input": {}, "cwd": "", "at": now_ms() }).to_string()).unwrap();
        let r = answer_in(&d, "ff", false, true).unwrap();
        assert_eq!(r["rule"], Value::Null);
        assert_eq!(rule_for("WebFetch", &json!({})), "WebFetch");
    }
}
